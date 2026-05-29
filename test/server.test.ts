import { afterEach, describe, expect, it } from "vitest";
import { close, connect } from "./mcp-testing-kit-shim.js";
import type { JSONRPCMessage, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type CodexClientLike, type ToolProfile } from "../src/index.js";

function textOf(result: any): string {
  return result.content[0].text;
}

class FakeCodexClient implements CodexClientLike {
  calls: Array<{ profile: ToolProfile; args: { prompt: string; model?: string; cwd?: string } }> = [];
  continueCalls: Array<{ sessionId: string; prompt: string; cwd?: string }> = [];
  resolveRun!: (value: CallToolResult) => void;
  rejectRun!: (reason: unknown) => void;
  runPromise = new Promise<CallToolResult>((resolve, reject) => {
    this.resolveRun = resolve;
    this.rejectRun = reject;
  });

  async callCodex(profile: ToolProfile, args: { prompt: string; model?: string; cwd?: string }): Promise<CallToolResult> {
    this.calls.push({ profile, args });
    return this.runPromise;
  }

  async continueSession(sessionId: string, prompt: string, cwd?: string): Promise<CallToolResult> {
    this.continueCalls.push({ sessionId, prompt, cwd });
    return { content: [{ type: "text", text: `continued ${sessionId}: ${prompt}` }] };
  }

  async close(): Promise<void> {}
}

const config = {
  codex: { command: "codex", args: ["mcp-server"], env: {} },
  tools: {
    "codex-write": {
      description: "Run Codex with safe defaults",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      config: {},
    },
  },
};

describe("async-codex-mcp server", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server) await close(server.server as never);
  });

  it("exposes configured profile tools plus session helpers", async () => {
    const fake = new FakeCodexClient();
    server = createServer(config, { client: fake });
    const client = await connect(server.server as never);

    const tools = await client.listTools();
    expect(tools.tools.map((tool: Tool) => tool.name).sort()).toEqual(["codex-write", "continue-session", "session-status"]);
  });

  it("starts Codex asynchronously, records completion, and resumes the Codex session", async () => {
    const fake = new FakeCodexClient();
    server = createServer(config, { client: fake });
    const client = await connect(server.server as never);
    const notifications: any[] = [];
    client.onNotification((message: JSONRPCMessage) => notifications.push(message));

    const started = await client.callTool("codex-write", { prompt: "build this", model: "gpt-5.4-mini", cwd: "/tmp/project" });
    const startedPayload = JSON.parse(textOf(started));

    expect(startedPayload.status).toBe("running");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].profile.sandboxMode).toBe("danger-full-access");
    expect(fake.calls[0].profile.approvalPolicy).toBe("never");
    expect(fake.calls[0].args).toEqual({ prompt: "build this", model: "gpt-5.4-mini", cwd: "/tmp/project" });

    fake.resolveRun({ content: [{ type: "text", text: "done" }], structuredContent: { threadId: "codex-123", content: "done" } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const status = await client.callTool("session-status", { session_id: startedPayload.session_id });
    const statusPayload = JSON.parse(textOf(status));
    expect(statusPayload.status).toBe("completed");
    expect(statusPayload.codexSessionId).toBe("codex-123");
    expect(notifications.some((message) => message.method === "notifications/message" && message.params.data.session_id === startedPayload.session_id)).toBe(true);

    const continued = await client.callTool("continue-session", { session_id: startedPayload.session_id, prompt: "next" });
    expect(textOf(continued)).toBe("continued codex-123: next");
    expect(fake.continueCalls).toEqual([{ sessionId: "codex-123", prompt: "next", cwd: "/tmp/project" }]);
  });

  it("reports failed background sessions", async () => {
    const fake = new FakeCodexClient();
    server = createServer(config, { client: fake });
    const client = await connect(server.server as never);

    const started = await client.callTool("codex-write", { prompt: "fail" });
    const { session_id } = JSON.parse(textOf(started));
    fake.rejectRun(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const status = await client.callTool("session-status", { session_id });
    const payload = JSON.parse(textOf(status));
    expect(payload.status).toBe("failed");
    expect(payload.error).toBe("boom");
  });
});
