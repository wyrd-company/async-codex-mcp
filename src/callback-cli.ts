#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const options = parseArgs(process.argv.slice(2));

const server = new McpServer(
  { name: "async-codex-mcp-callback", version: "0.3.0" },
  {
    instructions:
      "Use async_codex_ask_user only when you need a user answer before continuing. Use async_codex_notify_user for non-blocking progress updates or FYIs.",
  },
);

server.tool(
  "async_codex_ask_user",
  "Ask the user a blocking question. Codex waits until the user responds to the async session.",
  {
    message: z.string().min(1).describe("The question or problem that needs a user response."),
    context: z.string().optional().describe("Optional context explaining why the answer is needed."),
  },
  async ({ message, context }) => {
    const result = await postCallback<{ answer: string }>("/ask", { message, context });
    return textResult(result.answer);
  },
);

server.tool(
  "async_codex_notify_user",
  "Send a non-blocking progress update or FYI to the user.",
  {
    message: z.string().min(1).describe("The progress update or FYI to send."),
    topic: z.string().optional().describe("Optional free-text topic for the notification."),
  },
  async ({ message, topic }) => {
    await postCallback("/notify", { message, topic });
    return textResult("Notification delivered.");
  },
);

await server.connect(new StdioServerTransport());

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
    body: JSON.stringify({ ...body, session_id: options.sessionId }),
  });

  const json = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? `Callback failed with HTTP ${response.status}.`);
  }
  return json as T;
}

function parseArgs(args: string[]): { url: string; token: string; sessionId: string } {
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
  if (!url || !token || !sessionId) {
    throw new Error("--url, --token, and --session-id are required.");
  }

  return { url, token, sessionId };
}
