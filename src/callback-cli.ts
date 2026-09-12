#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { z } from "zod";

const options = parseArgs(process.argv.slice(2));

const handle = serveStdio(() => {
  const server = new McpServer(
    { name: "async-codex-mcp-callback", version: "0.6.0" },
    {
      instructions:
        "Use async_codex_ask_user only when you need a user answer before continuing. Use async_codex_notify_user for non-blocking progress updates or FYIs.",
    },
  );

  server.registerTool(
    "async_codex_ask_user",
    { description: "Ask the user a blocking question. Codex waits until the user responds to the async session.", inputSchema: z.object({
      message: z.string().min(1).describe("The question or problem that needs a user response."),
      context: z.string().optional().describe("Optional context explaining why the answer is needed."),
    }) },
    async ({ message, context }) => {
      const result = await postCallback<{ answer: string }>("/ask", { message, context });
      return textResult(result.answer);
    },
  );

  server.registerTool(
    "async_codex_notify_user",
    { description: "Send a non-blocking progress update or FYI to the user.", inputSchema: z.object({
      message: z.string().min(1).describe("The progress update or FYI to send."),
      topic: z.string().optional().describe("Optional free-text topic for the notification."),
    }) },
    async ({ message, topic }) => {
      await postCallback("/notify", { message, topic });
      return textResult("Notification delivered.");
    },
  );

  return server;
});
const lifetime = http.request(`${options.url}/lifecycle`, {
  method: "POST",
  headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
}, (response) => {
  response.resume();
  response.once("end", shutdown);
  response.once("error", shutdown);
});
lifetime.once("error", shutdown);
lifetime.end(JSON.stringify({ session_id: options.sessionId, round: options.round }));
process.stdin.once("end", shutdown);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  lifetime.destroy();
  void handle.close().finally(() => process.exit(0));
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function postCallback<T = unknown>(path: "/ask" | "/notify", body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${options.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, session_id: options.sessionId, round: options.round }),
  });

  const json = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? `Callback failed with HTTP ${response.status}.`);
  }
  return json as T;
}

function parseArgs(args: string[]): { url: string; token: string; sessionId: string; round: number } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid callback argument near ${key ?? "<end>"}.`);
    }
    values.set(key.slice(2), value);
  }

  const url = values.get("url");
  const token = values.get("token");
  const sessionId = values.get("session-id");
  const round = Number(values.get("round"));
  if (!url || !token || !sessionId || !Number.isInteger(round) || round < 1) {
    throw new Error("--url, --token, --session-id, and --round are required.");
  }

  return { url, token, sessionId, round };
}
