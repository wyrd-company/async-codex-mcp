// ---
// relationships:
//   verifies: ../src/server.ts
//   references: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
// ---
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
const config = {
  codex: { command: "codex", args: ["app-server"], env: {}, requestTimeoutSec: 86400 },
  callbacks: { enabled: false, askTimeoutSec: 3600 },
  tools: { worker: { approvalPolicy: "never", sandboxMode: "danger-full-access", config: {} } },
};

describe("dual-era MCP stdio", () => {
  let handle: StdioServerHandle;
  let directory: string;
  let input: PassThrough;
  let messages: any[];
  let request: (method: string, params?: Record<string, unknown>) => Promise<any>;
  let finish: (result: CallToolResult) => void;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "protocol-sessions-"));
    process.env.ASYNC_CODEX_MCP_SESSION_DIR = directory;
    input = new PassThrough();
    const output = new PassThrough();
    messages = [];
    const pending = new Map<number, (value: any) => void>();
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        messages.push(message);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    let id = 0;
    request = (method, params) => new Promise((resolve) => {
      pending.set(++id, resolve);
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const completion = new Promise<CallToolResult>((resolve) => { finish = resolve; });
    handle = serveStdio(({ era }) => createServer(config, {
      protocolEra: era,
      client: {
        callCodex: async () => completion,
        continueSession: async () => ({ content: [{ type: "text", text: "continued" }] }),
        close: async () => {},
      },
    }), { transport: new StdioServerTransport(input, output) });
  });

  afterEach(async () => {
    await handle.close();
    delete process.env.ASYNC_CODEX_MCP_SESSION_DIR;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("discovers modern capabilities and calls tools without initialize", async () => {
    const discovery = await request("server/discover", { _meta: modernMeta });
    expect(discovery.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "async-codex-mcp" } },
    });
    expect(discovery.result.capabilities.experimental).toBeUndefined();
    const listed = await request("tools/list", { _meta: modernMeta });
    expect(listed.result.resultType).toBe("complete");
    expect(listed.result.tools.map((tool: any) => tool.name)).toContain("worker");
    const result = await request("tools/call", { _meta: modernMeta, name: "session-status", arguments: { session_id: "missing" } });
    expect(result.result).toMatchObject({ resultType: "complete", isError: true });
  });

  it("returns supported versions and accepts a corrected discovery request", async () => {
    const unsupported = await request("server/discover", { _meta: { ...modernMeta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } });
    expect(unsupported.error).toMatchObject({ code: -32022, data: { supported: ["2026-07-28"], requested: "2099-01-01" } });
    const retry = await request("server/discover", { _meta: modernMeta });
    expect(retry.result.resultType).toBe("complete");
  });

  it("validates required metadata on each modern request", async () => {
    await request("tools/list", { _meta: modernMeta });
    for (const _meta of [
      { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      { "io.modelcontextprotocol/clientCapabilities": {} },
      { ...modernMeta, "io.modelcontextprotocol/clientCapabilities": "invalid" },
    ]) {
      expect((await request("tools/list", { _meta })).error.code).toBe(-32602);
    }
  });

  it.each(["2025-11-25", "2025-06-18", "2024-11-05"])("preserves initialize fallback for %s", async (protocolVersion) => {
    const initialized = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } });
    expect(initialized.result.protocolVersion).toBe(protocolVersion);
    expect(initialized.result.resultType).toBeUndefined();
    expect(initialized.result.capabilities.experimental).toEqual({ "claude/channel": {} });
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    expect((await request("tools/list")).result.tools.length).toBe(4);
  });

  it("allows a discovery probe followed by legacy initialization", async () => {
    await request("server/discover", { _meta: modernMeta });
    const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } });
    expect(initialized.result.protocolVersion).toBe("2025-11-25");
  });

  it("keeps background completion available by session id without unsolicited modern notifications", async () => {
    const started = await request("tools/call", { _meta: modernMeta, name: "worker", arguments: { prompt: "process a sample" } });
    const { session_id } = JSON.parse(started.result.content[0].text);
    finish({ content: [{ type: "text", text: "done" }], _meta: { threadId: "sample-thread" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const status = await request("tools/call", { _meta: modernMeta, name: "session-status", arguments: { session_id } });
    expect(JSON.parse(status.result.content[0].text)).toMatchObject({ status: "completed", codexSessionId: "sample-thread" });
    expect(messages.filter((message) => message.method)).toEqual([]);
  });
});
