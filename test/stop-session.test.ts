// ---
// relationships:
//   verifies: server
//   references: codex-client
// ---
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appServerFixture } from "./helpers/app-server.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import { close, connect } from "./mcp-testing-kit-shim.js";
const payload = (result: any) => JSON.parse(result.content[0].text);
let directory: string;
let server: ReturnType<typeof createServer>;
let fixture: Awaited<ReturnType<typeof appServerFixture>>;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "stop-session-"));
});
afterEach(async () => {
  if (server) await close(server.server as never);
  if (fixture) await fixture.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function setup(
  initializing = false,
  rejectInterrupt = false,
  terminalRace?: "before" | "after",
) {
  const config = loadConfig();
  fixture = await appServerFixture({
    holdInitialize: initializing,
    rejectInterrupt,
    terminalRace,
  });
  config.codex.endpoint = fixture.endpoint;
  const store = new SessionStore({
    directory: path.join(directory, "sessions"),
  });
  server = createServer(config, { store });
  return { client: await connect(server.server as never), store };
}
async function marker(key: string) {
  await expect.poll(() => fixture.held.has("hold:" + key)).toBe(true);
  const turn = fixture.held.get("hold:" + key)!;
  return { ...turn, profile: fixture.threads.get(turn.threadId) };
}
describe("stop-session", () => {
  it.each([false, true])(
    "interrupts a turn while waiting for input=%s and preserves another active session",
    async (waiting) => {
      const { client, store } = await setup();
      const a = payload(
        await client.callTool("codex", { prompt: "hold:alpha" }),
      ).session_id;
      const b = payload(
        await client.callTool("codex", { prompt: "hold:beta" }),
      ).session_id;
      const first = await marker("alpha");
      const second = await marker("beta");
      expect(first.threadId).not.toBe(second.threadId);
      let ask: Promise<Response> | undefined;
      if (waiting) {
        const args =
          first.profile.config.mcp_servers.async_codex_mcp_callback.args;
        ask = fetch(args[args.indexOf("--url") + 1] + "/ask", {
          method: "POST",
          headers: {
            authorization: "Bearer " + args[args.indexOf("--token") + 1],
            "content-type": "application/json",
          },
          body: JSON.stringify({
            session_id: a,
            round: 1,
            message: "Choose a sample.",
          }),
        });
        await expect.poll(() => store.get(a)?.status).toBe("waiting_for_input");
      }
      const stopped = await client.callTool("stop-session", { session_id: a });
      expect(stopped.isError).not.toBe(true);
      expect(payload(stopped)).toEqual({ session_id: a, status: "stopped" });
      expect(
        fixture.requests
          .filter((request) => request.method === "turn/interrupt")
          .map((request) => request.params),
      ).toEqual([{ threadId: first.threadId, turnId: first.turnId }]);
      expect(store.get(b)?.status).toBe("running");
      if (ask) expect((await ask).status).toBe(500);
      expect(
        (
          await client.callTool("answer-session", {
            session_id: a,
            message: "late",
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await client.callTool("continue-session", {
            session_id: a,
            prompt: "late",
          })
        ).isError,
      ).toBe(true);
      expect(
        (await client.callTool("stop-session", { session_id: a })).isError,
      ).toBe(true);
      expect(
        new SessionStore({ directory: path.join(directory, "sessions") }).get(a)
          ?.status,
      ).toBe("stopped");
      fixture.finish("hold:beta");
      await expect.poll(() => store.get(b)?.status).toBe("completed");
    },
  );
  it("forks with new callback arguments and persists the second result", async () => {
    const { client, store } = await setup();
    const id = payload(
      await client.callTool("codex", { prompt: "hold:alpha" }),
    ).session_id;
    const first = await marker("alpha");
    fixture.finish("hold:alpha");
    await expect.poll(() => store.get(id)?.status).toBe("completed");
    const continued = client.callTool("continue-session", {
      session_id: id,
      prompt: "hold:beta",
    });
    const second = await marker("beta");
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.profile.forkedFrom).toBe(first.threadId);
    expect(store.get(id)).toMatchObject({
      round: 2,
      status: "running",
      result: undefined,
    });
    const args =
      second.profile.config.mcp_servers.async_codex_mcp_callback.args;
    expect(args[args.indexOf("--round") + 1]).toBe("2");
    const callback = (round: number) =>
      fetch(args[args.indexOf("--url") + 1] + "/notify", {
        method: "POST",
        headers: {
          authorization: "Bearer " + args[args.indexOf("--token") + 1],
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: id,
          round,
          message: "Sample progress.",
        }),
      });
    expect((await callback(1)).status).toBe(409);
    expect((await callback(2)).status).toBe(200);
    fixture.finish("hold:beta");
    expect((await continued).content).toEqual([
      { type: "text", text: "finished hold:beta" },
    ]);
    const persisted = new SessionStore({
      directory: path.join(directory, "sessions"),
    }).get(id);
    expect(persisted).toMatchObject({
      round: 2,
      status: "completed",
      codexSessionId: second.threadId,
      result: { content: [{ type: "text", text: "finished hold:beta" }] },
    });
  });
  it("stops during app-server initialization before any thread exists", async () => {
    const { client, store } = await setup(true);
    const id = payload(
      await client.callTool("codex", { prompt: "sample" }),
    ).session_id;
    await expect
      .poll(() =>
        fixture.requests.some((request) => request.method === "initialize"),
      )
      .toBe(true);
    expect(
      payload(await client.callTool("stop-session", { session_id: id })).status,
    ).toBe("stopped");
    expect(
      fixture.requests.some((request) => request.method === "thread/start"),
    ).toBe(false);
    expect(store.get(id)?.status).toBe("stopped");
  });
  it("persists completed output when native completion wins the stop race", async () => {
    const { client, store } = await setup(false, false, "after");
    const id = payload(
      await client.callTool("codex", { prompt: "hold:alpha" }),
    ).session_id;
    await marker("alpha");
    const result = await client.callTool("stop-session", { session_id: id });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toEqual({ session_id: id, status: "completed" });
    const saved = new SessionStore({
      directory: path.join(directory, "sessions"),
    }).get(id);
    expect(saved).toMatchObject({
      status: "completed",
      result: {
        content: [{ type: "text", text: "Completed before interrupt." }],
      },
    });
    expect(store.get(id)?.status).toBe("completed");
  });
  it("ends the wrapper round when native interruption fails", async () => {
    const { client, store } = await setup(false, true);
    const id = payload(
      await client.callTool("codex", { prompt: "hold:alpha" }),
    ).session_id;
    await marker("alpha");
    const result = await client.callTool("stop-session", { session_id: id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Interruption rejected");
    expect(store.get(id)?.status).toBe("stopped");
    expect(
      new SessionStore({ directory: path.join(directory, "sessions") }).get(id)
        ?.status,
    ).toBe("stopped");
  });
  it("rejects unknown, terminal and foreign live records without mutation", async () => {
    const { client, store } = await setup();
    expect(
      (await client.callTool("stop-session", { session_id: "missing" }))
        .isError,
    ).toBe(true);
    const terminal = store.create({ toolName: "codex", prompt: "sample" });
    store.complete(terminal.id, { content: [] }, "thread-sample");
    const before = JSON.stringify(terminal);
    const terminalResult = await client.callTool("stop-session", {
      session_id: terminal.id,
    });
    expect(terminalResult.isError).toBe(true);
    expect((terminalResult.content[0] as { text: string }).text).toContain(
      "is completed",
    );
    expect(JSON.stringify(terminal)).toBe(before);
    const foreign = store.create({ toolName: "codex", prompt: "foreign" });
    expect(
      (await client.callTool("stop-session", { session_id: foreign.id }))
        .isError,
    ).toBe(true);
    expect(foreign.status).toBe("running");
  });
});
