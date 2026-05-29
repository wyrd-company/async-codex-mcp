import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CodexMcpClient, type CodexClientLike } from "./codex-client.js";
import type { AsyncCodexConfig } from "./config.js";
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

  for (const [name, profile] of Object.entries(config.tools)) {
    server.tool(
      name,
      profile.description ?? `Start an asynchronous Codex session using the ${name} profile.`,
      runShape,
      async ({ prompt, model, cwd }) => {
        const session = store.create({ toolName: name, prompt, model, cwd });

        void client
          .callCodex(profile, { prompt, model, cwd })
          .then(async (result) => {
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

  return server;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function sendSessionNotification(server: McpServer, sessionId: string, status: "completed" | "failed", codexSessionId?: string, error?: string) {
  await server.server.sendLoggingMessage({
    level: status === "completed" ? "notice" : "error",
    logger: "async-codex-mcp",
    data: { session_id: sessionId, status, codex_session_id: codexSessionId, error },
  });
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
