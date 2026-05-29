import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CallbackHub } from "./callback-hub.js";
import { CodexMcpClient, type CodexClientLike } from "./codex-client.js";
import type { AsyncCodexConfig, ToolProfile } from "./config.js";
import { SessionStore } from "./session-store.js";

const runShape = {
  prompt: z.string().min(1).describe("Prompt to send to Codex."),
  model: z.string().optional().describe("Optional model override for this run."),
  cwd: z.string().optional().describe("Optional working directory for Codex."),
};

const continueShape = {
  session_id: z.string().min(1).describe("Async session id returned by a profile tool."),
  prompt: z.string().min(1).describe("Prompt to continue the completed Codex session."),
  cwd: z.string().optional().describe("Optional working directory for Codex."),
};

const answerShape = {
  session_id: z.string().min(1).describe("Async session id waiting for user input."),
  message: z.string().min(1).describe("User response to return to Codex."),
};

export type CreateServerOptions = {
  client?: CodexClientLike;
  store?: SessionStore;
};

export function createServer(config: AsyncCodexConfig, options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "async-codex-mcp", version: "0.1.0" },
    {
      capabilities: { logging: {} },
      instructions:
        "Starts Codex sub-agent sessions asynchronously. Profile tools return immediately with an async session id; use continue-session after completion to resume.",
    },
  );
  const client = options.client ?? new CodexMcpClient(config);
  const store = options.store ?? new SessionStore();
  const callbackHub = new CallbackHub({
    ask: async ({ sessionId, message, context }) => {
      const ask = store.ask(sessionId, { message, context });
      await sendCallbackNotification(server, sessionId, "ask", message, { context });
      return ask.response;
    },
    notify: async ({ sessionId, message, topic }) => {
      store.notify(sessionId, { message, topic });
      await sendCallbackNotification(server, sessionId, "notify", message, { topic });
    },
  });

  let closeServicesPromise: Promise<void> | undefined;
  const closeServices = () => {
    closeServicesPromise ??= Promise.all([client.close(), callbackHub.close()]).then(() => undefined);
    return closeServicesPromise;
  };
  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    originalOnClose?.();
    void closeServices().catch((error: unknown) => {
      server.server.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });
  };
  const originalServerClose = server.server.close.bind(server.server);
  server.server.close = async () => {
    await originalServerClose();
    await closeServices();
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {
    await originalClose();
    await closeServices();
  };

  for (const [name, profile] of Object.entries(config.tools)) {
    server.tool(
      name,
      profile.description ?? `Start an asynchronous Codex session using the ${name} profile.`,
      runShape,
      async ({ prompt, model, cwd }) => {
        const session = store.create({ toolName: name, prompt, model, cwd });
        const effectiveProfile = await prepareProfile(config, profile, session.id, callbackHub);

        void client
          .callCodex(effectiveProfile, { prompt, model, cwd })
          .then(async (result) => {
            if (result.isError) {
              const message = errorMessageFromResult(result);
              store.update(session.id, { status: "failed", result, error: message });
              await sendSessionNotification(server, session.id, "failed", undefined, message);
              return;
            }

            const codexSessionId = extractCodexSessionId(result);
            store.update(session.id, { status: "completed", result, codexSessionId });
            await sendSessionNotification(server, session.id, "completed", codexSessionId);
          })
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            store.update(session.id, { status: "failed", error: message });
            await sendSessionNotification(server, session.id, "failed", undefined, message);
          });

        return textResult(
          JSON.stringify(
            {
              session_id: session.id,
              status: session.status,
              message: "Codex session started. Watch notifications/message for completion.",
            },
            null,
            2,
          ),
        );
      },
    );
  }

  server.tool(
    "session-status",
    "Inspect an asynchronous Codex session by id.",
    { session_id: z.string().min(1).describe("Async session id returned by a profile tool.") },
    async ({ session_id }) => {
      const session = store.get(session_id);
      if (!session) {
        return textResult(`Unknown session: ${session_id}`, true);
      }

      return textResult(
        JSON.stringify(
          {
            id: session.id,
            toolName: session.toolName,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            codexSessionId: session.codexSessionId,
            error: session.error,
            messages: session.messages,
            pendingAskId: session.pendingAskId,
            result: session.result,
          },
          null,
          2,
        ),
      );
    },
  );

  server.tool("continue-session", "Resume a completed async Codex session.", continueShape, async ({ session_id, prompt, cwd }) => {
    const session = store.get(session_id);
    if (!session) return textResult(`Unknown session: ${session_id}`, true);
    if (session.status !== "completed") return textResult(`Session ${session_id} is ${session.status}; only completed sessions can be continued.`, true);
    if (!session.codexSessionId) return textResult(`Session ${session_id} did not expose a Codex session id.`, true);

    try {
      const result = await client.continueSession(session.codexSessionId, prompt, cwd ?? session.cwd);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(message, true);
    }
  });

  server.tool("answer-session", "Answer a Codex question for an async session waiting for input.", answerShape, async ({ session_id, message }) => {
    const session = store.get(session_id);
    if (!session) return textResult(`Unknown session: ${session_id}`, true);
    if (session.status !== "waiting_for_input") return textResult(`Session ${session_id} is ${session.status}; only waiting_for_input sessions can be answered.`, true);

    try {
      const answered = store.answer(session_id, message);
      return textResult(
        JSON.stringify(
          {
            session_id,
            answered_message_id: answered.id,
            status: store.get(session_id)?.status,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return textResult(errorMessage, true);
    }
  });

  return server;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function errorMessageFromResult(result: CallToolResult): string {
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

  return text || "Codex returned an error result.";
}

async function sendSessionNotification(server: McpServer, sessionId: string, status: "completed" | "failed", codexSessionId?: string, error?: string) {
  await server.server.sendLoggingMessage({
    level: status === "completed" ? "notice" : "error",
    logger: "async-codex-mcp",
    data: { session_id: sessionId, status, codex_session_id: codexSessionId, error },
  });
}

async function sendCallbackNotification(
  server: McpServer,
  sessionId: string,
  type: "ask" | "notify",
  message: string,
  extra: { context?: string; topic?: string },
) {
  await server.server.sendLoggingMessage({
    level: type === "ask" ? "warning" : "info",
    logger: "async-codex-mcp",
    data: { session_id: sessionId, type, message, ...extra },
  });
}

async function prepareProfile(config: AsyncCodexConfig, profile: ToolProfile, sessionId: string, callbackHub: CallbackHub): Promise<ToolProfile> {
  if (!callbacksEnabled(config, profile)) {
    return profile;
  }

  const connection = await callbackHub.ensureStarted();
  return {
    ...profile,
    developerInstructions: appendCallbackInstructions(profile.developerInstructions),
    config: {
      ...profile.config,
      mcp_servers: {
        ...recordValue(profile.config.mcp_servers),
        async_codex_mcp_callback: {
          command: process.execPath,
          args: [
            callbackCliPath(),
            "--url",
            connection.url,
            "--token",
            connection.token,
            "--session-id",
            sessionId,
          ],
        },
      },
    },
  };
}

function callbacksEnabled(config: AsyncCodexConfig, profile: ToolProfile): boolean {
  return profile.callbacks?.enabled ?? config.callbacks.enabled;
}

function appendCallbackInstructions(existing: string | undefined): string {
  const callbackInstructions =
    "You have two callback tools for communicating with the user during this async Codex session. " +
    "Call async_codex_ask_user with message and optional context only when you need a user answer before continuing; the tool blocks until the user answers. " +
    "Call async_codex_notify_user with message and optional topic for non-blocking progress updates, warnings, or FYIs.";

  return existing ? `${existing}\n\n${callbackInstructions}` : callbackInstructions;
}

function callbackCliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "callback-cli.js");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function extractCodexSessionId(result: CallToolResult): string | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  for (const key of ["threadId", "session_id", "sessionId", "codex_session_id", "codexSessionId"]) {
    const value = meta?.[key];
    if (typeof value === "string") return value;
  }

  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (typeof structured?.threadId === "string") return structured.threadId;

  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const match = text.match(/(?:thread[_ -]?id|session[_ -]?id|codex[_ -]?session[_ -]?id)["'`:\s]+([a-zA-Z0-9_-]+)/i);
  return match?.[1];
}
