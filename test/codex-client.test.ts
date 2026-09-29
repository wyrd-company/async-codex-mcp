// ---
// relationships:
//   verifies: codex-client
// ---
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CodexAppServerClient,
  appServerEndpoint,
} from "../src/codex-client.js";
import { loadConfig } from "../src/config.js";
import { appServerFixture } from "./helpers/app-server.js";
const clients: CodexAppServerClient[] = [];
const fixtures: Awaited<ReturnType<typeof appServerFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  vi.unstubAllEnvs();
});
async function setup(options: Parameters<typeof appServerFixture>[0] = {}) {
  const fixture = await appServerFixture(options);
  fixtures.push(fixture);
  const config = loadConfig();
  config.codex.endpoint = fixture.endpoint;
  const client = new CodexAppServerClient(config);
  clients.push(client);
  return { client, config, profile: config.tools.codex, fixture };
}
describe("Existing Codex app-server adapter", () => {
  it("maps profiles and preserves thread IDs when completion precedes the start response", async () => {
    const { client, profile } = await setup();
    const result = await client.callCodex(
      {
        ...profile,
        model: "profile-model",
        sandboxMode: "read-only",
        baseInstructions: "Base",
        developerInstructions: "Developer",
        compactPrompt: "Compact",
        config: { feature: true },
      },
      { prompt: "Hello", model: "override-model", cwd: "/tmp" },
    );
    expect(result._meta).toEqual({ threadId: "thread-1" });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      text: "Hello",
      profile: {
        model: "override-model",
        cwd: "/tmp",
        sandbox: "read-only",
        approvalPolicy: "never",
        baseInstructions: "Base",
        developerInstructions: "Developer",
        config: { feature: true, compact_prompt: "Compact" },
      },
    });
  });
  it("multiplexes concurrent first calls through one connection", async () => {
    const { client, profile, fixture } = await setup();
    const results = await Promise.all(
      ["one", "two", "three"].map((prompt) =>
        client.callCodex(profile, { prompt }),
      ),
    );
    expect(results.map((result) => result._meta?.threadId)).toEqual([
      "thread-1",
      "thread-2",
      "thread-3",
    ]);
    expect(fixture.connections).toBe(1);
  });
  it("shares a server across clients and filters unrelated thread notifications", async () => {
    const { client, config, profile, fixture } = await setup();
    const b = new CodexAppServerClient(config);
    clients.push(b);
    const first = client.callCodex(profile, { prompt: "hold:alpha" });
    await expect.poll(() => fixture.held.has("hold:alpha")).toBe(true);
    const result = await b.callCodex(profile, { prompt: "beta" });
    expect(result._meta?.threadId).toBe("thread-2");
    fixture.finish("hold:alpha");
    expect((await first).content).toEqual([
      { type: "text", text: "finished hold:alpha" },
    ]);
    expect(fixture.connections).toBe(2);
  });
  it("forks durable threads with current configuration while the source remains subscribed", async () => {
    const { client, config, profile } = await setup();
    const result = await client.callCodex(profile, { prompt: "first" });
    const b = new CodexAppServerClient(config);
    clients.push(b);
    const continued = await b.continueSession(
      result._meta!.threadId as string,
      "second",
      "/tmp",
      { ...profile, config: { round: 2 } },
    );
    expect(continued._meta?.threadId).not.toBe(result._meta?.threadId);
    expect(
      JSON.parse((continued.content[0] as { text: string }).text).profile,
    ).toMatchObject({
      config: { round: 2 },
      forkedFrom: result._meta?.threadId,
    });
  });
  it.each(["fail", "interrupt", "rpc-error"])(
    "settles %s turns as failures",
    async (prompt) => {
      const { client, profile } = await setup();
      await expect(client.callCodex(profile, { prompt })).rejects.toThrow(
        /fixture failure|interrupted|Invalid turn/,
      );
    },
  );
  it("reports a missing existing server without spawning a configured executable", async () => {
    const { config, fixture } = await setup();
    config.codex.endpoint = fixture.endpoint + "-missing";
    config.codex.command = "/missing-executable";
    const client = new CodexAppServerClient(config);
    clients.push(client);
    await expect(
      client.callCodex(config.tools.codex, { prompt: "hello" }),
    ).rejects.toThrow(/Cannot connect to existing Codex app-server/);
  });
  it("rejects malformed messages without shutting down the server", async () => {
    const { client, profile, config } = await setup();
    await expect(
      client.callCodex(profile, { prompt: "invalid" }),
    ).rejects.toThrow(/invalid JSON/);
    const b = new CodexAppServerClient(config);
    clients.push(b);
    await expect(
      b.callCodex(profile, { prompt: "hello" }),
    ).resolves.toMatchObject({ _meta: { threadId: "thread-2" } });
  });
  it("settles pending work on disconnect and reconnects to the same listener", async () => {
    const { client, profile } = await setup();
    const results = await Promise.allSettled(
      ["hold", "crash"].map((prompt) => client.callCodex(profile, { prompt })),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await expect(
      client.callCodex(profile, { prompt: "recovered" }),
    ).resolves.toMatchObject({ _meta: { threadId: "thread-3" } });
  });
  it("retains the existing 60-second initialization limit", async () => {
    const { client, profile, fixture } = await setup({ holdInitialize: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const assertion = expect(
      client.callCodex(profile, { prompt: "hello" }),
    ).rejects.toThrow(/initialize exceeded its 60s wait limit/);
    await vi.waitFor(() =>
      expect(
        fixture.requests.some((request) => request.method === "initialize"),
      ).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });
  it("interrupts a timed-out turn", async () => {
    const { client, config, profile, fixture } = await setup();
    config.codex.requestTimeoutSec = 1;
    await expect(client.callCodex(profile, { prompt: "hold" })).rejects.toThrow(
      /exceeded codex.requestTimeoutSec/,
    );
    await expect
      .poll(() =>
        fixture.requests.some((request) => request.method === "turn/interrupt"),
      )
      .toBe(true);
  });
  it("closes while initialization is pending", async () => {
    const { client, profile } = await setup({ holdInitialize: true });
    const assertion = expect(
      client.callCodex(profile, { prompt: "hello" }),
    ).rejects.toThrow(/closed/);
    await client.close();
    await assertion;
  });
  it("waits for a pending turn start and interrupts only its acknowledged turn", async () => {
    const { client, profile, fixture } = await setup({ delayTurnStart: true });
    const result = expect(
      client.callCodex(profile, { prompt: "hold" }),
    ).rejects.toThrow(/interrupted|closed/);
    await expect.poll(() => fixture.held.has("hold")).toBe(true);
    const stopped = client.stop();
    expect(
      fixture.requests.some((request) => request.method === "turn/interrupt"),
    ).toBe(false);
    fixture.acknowledge();
    await stopped;
    await result;
    expect(
      fixture.requests
        .filter((request) => request.method === "turn/interrupt")
        .map((request) => request.params),
    ).toEqual([{ threadId: "thread-1", turnId: "turn-thread-1" }]);
  });
  it("reports a rejected pending start instead of confirming native cancellation", async () => {
    const { client, profile, fixture } = await setup({ delayTurnStart: true });
    const result = expect(
      client.callCodex(profile, { prompt: "hold" }),
    ).rejects.toThrow(/Unconfirmed start/);
    await expect.poll(() => fixture.held.has("hold")).toBe(true);
    const stopped = expect(client.stop()).rejects.toThrow(/Unconfirmed start/);
    const start = fixture.requests.find(
      (request) => request.method === "turn/start",
    );
    fixture.notify({ id: start.id, error: { message: "Unconfirmed start" } });
    await stopped;
    await result;
  });
  it("prevents a turn after stopping during thread creation", async () => {
    const { client, profile, fixture } = await setup({
      delayThreadStart: true,
    });
    const result = expect(
      client.callCodex(profile, { prompt: "hold" }),
    ).rejects.toThrow(/closed/);
    await expect
      .poll(() =>
        fixture.requests.some((request) => request.method === "thread/start"),
      )
      .toBe(true);
    await client.stop();
    fixture.acknowledge();
    await result;
    expect(
      fixture.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
  });
  it("interrupts owned turns during normal client cleanup", async () => {
    const { client, profile, fixture } = await setup();
    const result = expect(
      client.callCodex(profile, { prompt: "hold" }),
    ).rejects.toThrow(/interrupted|closed/);
    await expect.poll(() => fixture.held.has("hold")).toBe(true);
    await client.close();
    await result;
    expect(
      fixture.requests.some((request) => request.method === "turn/interrupt"),
    ).toBe(true);
  });
  it("reports failed native cancellation instead of confirming stop", async () => {
    const { client, profile, fixture } = await setup({ rejectInterrupt: true });
    const result = expect(
      client.callCodex(profile, { prompt: "hold" }),
    ).rejects.toThrow(/closed/);
    await expect.poll(() => fixture.held.has("hold")).toBe(true);
    await expect(client.stop()).rejects.toThrow(/Interruption rejected/);
    await result;
  });
  it("rejects unsupported server requests explicitly", async () => {
    const { client, profile, fixture } = await setup();
    await client.callCodex(profile, { prompt: "request" });
    await expect
      .poll(() =>
        fixture.requests.some(
          (request) =>
            request.id === "server-request" && request.error?.code === -32601,
        ),
      )
      .toBe(true);
  });
  it("ignores an earlier turn on the same shared thread before its start response", async () => {
    const { client, profile, fixture } = await setup({ delayTurnStart: true });
    const pending = client.callCodex(profile, { prompt: "hold" });
    await expect.poll(() => fixture.held.has("hold")).toBe(true);
    fixture.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "old-turn",
          status: "completed",
          items: [{ id: "old-message", type: "agentMessage", text: "stale" }],
        },
      },
    });
    fixture.finish("hold");
    fixture.acknowledge();
    expect((await pending).content).toEqual([
      { type: "text", text: "finished hold" },
    ]);
  });
  it("passes the MCP working directory when the service starts elsewhere", async () => {
    const { client, profile, config, fixture } = await setup();
    config.codex.cwd = "/tmp/sample-workspace";
    await client.callCodex(profile, { prompt: "hello" });
    expect(fixture.threads.get("thread-1").cwd).toBe("/tmp/sample-workspace");
  });
  it("discovers canonical CODEX_HOME and honors an explicit endpoint", async () => {
    const { config, fixture } = await setup();
    delete config.codex.endpoint;
    const alias = path.join(fixture.directory, "profile");
    fs.symlinkSync(fixture.directory, alias);
    config.codex.env = { CODEX_HOME: alias };
    expect(appServerEndpoint(config)).toBe(
      "unix://" +
        fixture.directory +
        "/app-server-control/app-server-control.sock",
    );
    config.codex.endpoint = fixture.endpoint;
    expect(appServerEndpoint(config)).toBe(fixture.endpoint);
  });
});
