import { McpServer, type ProtocolEra } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CallbackHub } from "./callback-hub.js";
import { CodexMcpClient, type CodexClientLike } from "./codex-client.js";
import type { AsyncCodexConfig, ToolProfile } from "./config.js";
import { SessionStore, type SessionRecord } from "./session-store.js";
import { removeStateFile, writeStateFile } from "./state-file.js";

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
  protocolEra?: ProtocolEra;
};

export function createServer(config: AsyncCodexConfig, options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "async-codex-mcp", version: "0.7.1" },
    {
      capabilities: options.protocolEra === "modern" ? {} : { logging: {}, experimental: { "claude/channel": {} } },
      instructions:
        "Starts Codex sub-agent sessions asynchronously. Profile tools return immediately with an async session id; use continue-session after completion to resume. " +
        'If this server runs as a Claude Code channel (requires an Anthropic account with channel support enabled), session events arrive as <channel source="async-codex-mcp" session_id="..." kind="...">. ' +
        "kind=ask means Codex is blocked waiting for input: call answer-session with the session_id from the tag. " +
        "kind=notify is a non-blocking progress update. kind=completed, kind=failed, or kind=stopped means the session finished; use session-status. Only completed sessions can be continued. Call stop-session to terminate a running or waiting session. " +
        "Without channel support, do not poll session-status in a sleep loop. A Stop hook blocks you from ending your turn while sessions you started are still active, unless a watcher is already monitoring them. " +
        "When blocked, the hook's reason gives an absolute command that works from the installed plugin: run it via Bash with run_in_background true. Global npm installs also expose async-codex-mcp-watch on PATH. " +
        "The default watcher covers the conversation; add --session-id <async-session-id> to cover only one session. It prints status changes and notify messages, and exits once its covered sessions settle or need input. " +
        "Once it's running, stopping is allowed again; when it exits, check session-status: if a session is waiting_for_input, answer it with answer-session, then restart the watcher if others are still running.",
    },
  );
  const notificationsEnabled = options.protocolEra !== "modern";
  const clients = new Set<CodexClientLike>();
  if (options.client) clients.add(options.client);
  const store = options.store ?? new SessionStore({ retention: config.retention });
  store.onChange = (current) => {
    try {
      writeStateFile(current.ownedSessions());
    } catch (error) {
      server.server.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  function reportError(error: unknown): void {
    try { server.server.onerror?.(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
  }
  const callbackHub = new CallbackHub({
    ask: async ({ sessionId, message, context }) => {
      const ask = store.ask(sessionId, { message, context });
      if (notificationsEnabled) void sendCallbackNotification(server, sessionId, "ask", message, { context }).catch(reportError);
      return ask.response;
    },
    notify: async ({ sessionId, message, topic }) => {
      store.notify(sessionId, { message, topic });
      if (notificationsEnabled) await sendCallbackNotification(server, sessionId, "notify", message, { topic }).catch(reportError);
    },
  });

  const rounds = new Map<string, { client: CodexClientLike; stopping: boolean; done?: Promise<CallToolResult> }>();

  let closeServicesPromise: Promise<void> | undefined;
  const closeServices = () => {
    store.interruptOwned();
    closeServicesPromise ??= Promise.all([...clients].map((client) => client.close()).concat(callbackHub.close())).then(() => {
      try {
        removeStateFile();
      } catch {
        // best-effort cleanup; the Stop hook also ignores files from dead pids
      }
    });
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

  function runRound(session: SessionRecord, resume: boolean): Promise<CallToolResult> {
    const client = options.client ?? new CodexMcpClient(config);
    const runtime = { client, stopping: false, done: undefined as Promise<CallToolResult> | undefined };
    rounds.set(session.id, runtime);
    clients.add(client);
    runtime.done = executeRound(session, resume, runtime);
    return runtime.done;
  }

  async function executeRound(session: SessionRecord, resume: boolean, runtime: { client: CodexClientLike; stopping: boolean }): Promise<CallToolResult> {
    const round = session.round ?? 1;
    const { client } = runtime;
    const profile = config.tools[session.toolName];
    try {
      if (!profile) throw new Error(`Profile ${session.toolName} is no longer configured.`);
      const effectiveProfile = await prepareProfile(config, { ...profile, model: session.model ?? profile.model }, session.id, round, callbackHub);
      if (runtime.stopping || closeServicesPromise) throw new Error("Session stopped before Codex started.");
      const result = resume
        ? await client.continueSession(session.codexSessionId!, session.prompt, session.cwd, effectiveProfile)
        : await client.callCodex(effectiveProfile, { prompt: session.prompt, model: session.model, cwd: session.cwd });
      if (runtime.stopping) return textResult("Session stopped.", true);
      if (result.isError) store.fail(session.id, errorMessageFromResult(result), result, round);
      else store.complete(session.id, result, extractCodexSessionId(result), round);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!runtime.stopping) store.fail(session.id, message, undefined, round);
      return textResult(message, true);
    } finally {
      callbackHub.endRound(session.id, round);
      if (!options.client) {
        try { await client.close(); } finally { clients.delete(client); }
      }
      if (runtime.stopping) store.stop(session.id, round);
      if (rounds.get(session.id) === runtime) rounds.delete(session.id);
      if (notificationsEnabled && (session.round ?? 1) === round) {
        try {
          await sendSessionNotification(server, session.id, session.status === "completed" ? "completed" : session.status === "stopped" ? "stopped" : "failed", session.codexSessionId, session.error);
        } catch { /* Transport closure cannot undo durable completion. */ }
      }
    }
  }

  for (const [name, profile] of Object.entries(config.tools)) {
    server.registerTool(name, {
      description: profile.description ?? `Start an asynchronous Codex session using the ${name} profile.`, inputSchema: z.object(runShape),
    }, async ({ prompt, model, cwd }) => {
      const session = store.create({ toolName: name, prompt, model, cwd });
      void runRound(session, false).catch((error: unknown) => {
        // Persistence errors are reported without escaping a background promise.
        try { server.server.onerror?.(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
      });
      return textResult(JSON.stringify({ session_id: session.id, round: session.round, status: session.status, message: "Codex session started. Use session-status or the watcher for completion." }));
    });
  }

  server.registerTool(
    "session-status",
    { description: "Inspect an asynchronous Codex session by id.", inputSchema: z.object({ session_id: z.string().min(1).describe("Async session id returned by a profile tool.") }) },
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
            round: session.round ?? 1,
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

  server.registerTool("continue-session", { description: "Resume a completed async Codex session.", inputSchema: z.object(continueShape) }, async ({ session_id, prompt, cwd }) => {
    const session = store.get(session_id);
    if (!session) return textResult(`Unknown session: ${session_id}`, true);
    if (session.status !== "completed") return textResult(`Session ${session_id} is ${session.status}; only completed sessions can be continued.`, true);
    if (!session.codexSessionId) return textResult(`Session ${session_id} did not expose a Codex session id.`, true);

    try {
      if (rounds.has(session_id)) return textResult(`Session ${session_id} is still settling.`, true);
      const continued = store.beginRound(session_id, prompt, cwd);
      return await runRound(continued, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(message, true);
    }
  });

  server.registerTool("stop-session", {
    description: "Stop a running or waiting session owned by this MCP server. Waits for its Codex process to exit.",
    inputSchema: z.object({ session_id: z.string().min(1) }),
  }, async ({ session_id }) => {
    const session = store.get(session_id);
    if (!session) return textResult(`Unknown session: ${session_id}`, true);
    if (session.status !== "running" && session.status !== "waiting_for_input") return textResult(`Session ${session_id} is ${session.status}; only running or waiting sessions can be stopped.`, true);
    const runtime = rounds.get(session_id);
    if (!runtime) return textResult(`Session ${session_id} is owned by another MCP server; stop it through that server.`, true);
    if (!runtime.client.stop || (options.client && [...rounds.values()].some(other => other !== runtime && other.client === runtime.client))) return textResult("The configured Codex client does not support isolated stopping.", true);
    if (runtime.stopping) return textResult(`Session ${session_id} is already stopping.`, true);
    runtime.stopping = true;
    try {
      await runtime.client.stop();
      await runtime.done;
      return textResult(JSON.stringify({ session_id, status: store.get(session_id)?.status }));
    } catch (error) {
      runtime.stopping = false;
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  server.registerTool("answer-session", { description: "Answer a Codex question for an async session waiting for input.", inputSchema: z.object(answerShape) }, async ({ session_id, message }) => {
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

async function sendChannelNotification(server: McpServer, content: string, meta: Record<string, string | undefined>) {
  const cleanMeta = Object.fromEntries(
    Object.entries(meta).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  await server.server.notification({
    method: "notifications/claude/channel",
    params: { content, meta: cleanMeta },
  });
}

async function sendSessionNotification(server: McpServer, sessionId: string, status: "completed" | "failed" | "stopped", codexSessionId?: string, error?: string) {
  await server.server.sendLoggingMessage({
    level: status === "failed" ? "error" : "notice",
    logger: "async-codex-mcp",
    data: { session_id: sessionId, status, codex_session_id: codexSessionId, error },
  });
  await sendChannelNotification(
    server,
    status === "completed"
      ? `Async Codex session ${sessionId} completed. Use session-status to read the result or continue-session to resume.`
      : status === "stopped" ? `Async Codex session ${sessionId} stopped.`
      : `Async Codex session ${sessionId} failed: ${error ?? "unknown error"}`,
    { session_id: sessionId, kind: status, codex_session_id: codexSessionId },
  );
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
  await sendChannelNotification(
    server,
    extra.context ? `${message}\n\nContext: ${extra.context}` : message,
    { session_id: sessionId, kind: type, topic: extra.topic },
  );
}

async function prepareProfile(config: AsyncCodexConfig, profile: ToolProfile, sessionId: string, round: number, callbackHub: CallbackHub): Promise<ToolProfile> {
  if (!callbacksEnabled(config, profile)) {
    return profile;
  }

  const connection = await callbackHub.ensureStarted();
  callbackHub.beginRound(sessionId, round);
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
            "--round",
            String(round),
          ],
          // Codex aborts blocked ask_user calls at its default MCP tool
          // timeout (60s); a human answer routinely takes longer.
          tool_timeout_sec: profile.callbacks?.askTimeoutSec ?? config.callbacks.askTimeoutSec,
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
