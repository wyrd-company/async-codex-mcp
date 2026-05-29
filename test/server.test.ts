import { afterEach, describe, expect, it } from "vitest";
import { close, connect } from "./mcp-testing-kit-shim.js";
import type { JSONRPCMessage, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, loadConfig, type CodexClientLike, type ToolProfile } from "../src/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function textOf(result: any): string {
  return result.content[0].text;
}

class FakeCodexClient implements CodexClientLike {
  calls: Array<{ profile: ToolProfile; args: { prompt: string; model?: string; cwd?: string } }> = [];
  continueCalls: Array<{ sessionId: string; prompt: string; cwd?: string }> = [];
  closeCalls = 0;
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

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const config = {
  codex: { command: "codex", args: ["mcp-server"], env: {} },
  callbacks: { enabled: true },
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
    expect(tools.tools.map((tool: Tool) => tool.name).sort()).toEqual(["answer-session", "codex-write", "continue-session", "session-status"]);
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
    expect(Object.keys(fake.calls[0].profile.config.mcp_servers as Record<string, unknown>)).toContain("async_codex_mcp_callback");
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

  it("treats resolved MCP error results as failed background sessions", async () => {
    const fake = new FakeCodexClient();
    server = createServer(config, { client: fake });
    const client = await connect(server.server as never);

    const started = await client.callTool("codex-write", { prompt: "fail as result" });
    const { session_id } = JSON.parse(textOf(started));
    fake.resolveRun({ content: [{ type: "text", text: "Codex rejected the request" }], isError: true });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const status = await client.callTool("session-status", { session_id });
    const payload = JSON.parse(textOf(status));
    expect(payload.status).toBe("failed");
    expect(payload.error).toBe("Codex rejected the request");
    expect(payload.result.isError).toBe(true);
  });

  it("closes the Codex client when the MCP server closes", async () => {
    const fake = new FakeCodexClient();
    server = createServer(config, { client: fake });
    await connect(server.server as never);

    await close(server.server as never);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fake.closeCalls).toBe(1);
    server = undefined;
  });

  it("supports non-blocking notifications and blocking questions from Codex callbacks", async () => {
    const fake = new FakeCodexClient();
    server = createServer(config, { client: fake });
    const client = await connect(server.server as never);

    const started = await client.callTool("codex-write", { prompt: "needs callbacks" });
    const { session_id } = JSON.parse(textOf(started));
    const callback = callbackConnection(fake.calls[0].profile);

    const notify = await fetch(`${callback.url}/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${callback.token}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id, message: "halfway done", topic: "progress" }),
    });
    expect(notify.ok).toBe(true);

    const askPromise = fetch(`${callback.url}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${callback.token}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id, message: "Which target?", context: "Found staging and production." }),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const waitingStatus = await client.callTool("session-status", { session_id });
    const waitingPayload = JSON.parse(textOf(waitingStatus));
    expect(waitingPayload.status).toBe("waiting_for_input");
    expect(waitingPayload.messages.map((message: any) => message.type)).toEqual(["notify", "ask"]);
    expect(waitingPayload.messages[1].message).toBe("Which target?");

    const answered = await client.callTool("answer-session", { session_id, message: "Use staging." });
    const answeredPayload = JSON.parse(textOf(answered));
    expect(answeredPayload.status).toBe("running");

    const ask = await askPromise;
    expect(await ask.json()).toEqual({ answer: "Use staging." });

    fake.resolveRun({ content: [{ type: "text", text: "done" }], structuredContent: { threadId: "codex-123" } });
  });

  it("allows callback tool injection to be disabled per tool", async () => {
    const fake = new FakeCodexClient();
    server = createServer(
      {
        ...config,
        tools: {
          "codex-write": {
            ...config.tools["codex-write"],
            callbacks: { enabled: false },
          },
        },
      },
      { client: fake },
    );
    const client = await connect(server.server as never);

    await client.callTool("codex-write", { prompt: "no callbacks" });

    expect(fake.calls[0].profile.config.mcp_servers).toBeUndefined();
    fake.resolveRun({ content: [{ type: "text", text: "done" }] });
  });

  it("rejects unsupported profile fields in tool configuration", () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "async-codex-config-")), "config.yaml");
    fs.writeFileSync(
      configPath,
      `
tools:
  codex-write:
    profile: unsupported
`,
      "utf8",
    );

    expect(() => loadConfig(configPath)).toThrow(/unrecognized_keys[\s\S]*profile/);
  });
});

function callbackConnection(profile: ToolProfile): { url: string; token: string } {
  const mcpServers = profile.config.mcp_servers as Record<string, { args: string[] }>;
  const args = mcpServers.async_codex_mcp_callback.args;
  return {
    url: args[args.indexOf("--url") + 1],
    token: args[args.indexOf("--token") + 1],
  };
}
