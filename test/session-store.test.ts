import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRecordFileLock } from "../src/retention.js";
import { SessionStore } from "../src/session-store.js";

describe("SessionStore persistence", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "async-codex-session-store-"),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("rehydrates completed sessions for continuation", () => {
    const original = new SessionStore({ directory });
    const session = original.create({
      toolName: "codex",
      prompt: "perform a task",
      cwd: "/tmp/workspace",
    });
    original.complete(
      session.id,
      { content: [{ type: "text", text: "done" }] },
      "codex-thread",
    );

    const recovered = new SessionStore({
      directory,
      ownerAlive: () => false,
    }).get(session.id);

    expect(recovered).toEqual(
      expect.objectContaining({
        id: session.id,
        status: "completed",
        codexSessionId: "codex-thread",
        cwd: "/tmp/workspace",
      }),
    );
  });

  it("does not interrupt a session still owned by another live MCP server", () => {
    const original = new SessionStore({ directory });
    const session = original.create({
      toolName: "codex",
      prompt: "perform a task",
    });

    const observed = new SessionStore({
      directory,
      ownerAlive: () => true,
    }).get(session.id);

    expect(observed?.status).toBe("running");
  });

  it("marks only this server's live sessions interrupted on clean shutdown", async () => {
    const store = new SessionStore({ directory });
    const session = store.create({
      toolName: "codex",
      prompt: "perform a task",
    });
    const ask = store.ask(session.id, { message: "Which option?" });

    store.interruptOwned();

    await expect(ask.response).rejects.toThrow(/server stopped/);
    expect(store.get(session.id)).toEqual(
      expect.objectContaining({
        status: "interrupted",
        pendingAskId: undefined,
      }),
    );
  });

  it.each(["running", "waiting_for_input"] as const)(
    "recovers %s sessions as interrupted",
    (status) => {
      const original = new SessionStore({ directory });
      const session = original.create({
        toolName: "codex",
        prompt: "perform a task",
      });
      if (status === "waiting_for_input") {
        void original
          .ask(session.id, { message: "Which option?" })
          .response.catch(() => undefined);
      }

      const recovered = new SessionStore({
        directory,
        ownerAlive: () => false,
      }).get(session.id);

      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.pendingAskId).toBeUndefined();
      expect(recovered?.error).toMatch(/stopped before/);
    },
  );

  it("ignores malformed records while loading valid sessions", () => {
    const original = new SessionStore({ directory });
    const session = original.create({
      toolName: "codex",
      prompt: "perform a task",
    });
    original.complete(
      session.id,
      { content: [{ type: "text", text: "done" }] },
      "codex-thread",
    );
    fs.writeFileSync(path.join(directory, "malformed.json"), "{");

    const recovered = new SessionStore({ directory });

    expect(recovered.get(session.id)?.status).toBe("completed");
    expect(recovered.sessions).toHaveLength(1);
  });

  it("writes atomic user-only record files", () => {
    const store = new SessionStore({ directory });
    const session = store.create({
      toolName: "codex",
      prompt: "perform a task",
    });
    const entries = fs.readdirSync(directory);

    expect(entries).toEqual([`${session.id}.json`]);
    expect(fs.statSync(path.join(directory, entries[0])).mode & 0o777).toBe(
      0o600,
    );
  });

  it("persists round identity and rejects late finalizers from earlier rounds", () => {
    const store = new SessionStore({ directory });
    const session = store.create({ toolName: "worker", prompt: "first" });
    store.complete(
      session.id,
      { content: [{ type: "text", text: "first" }] },
      "sample-thread",
      1,
    );
    store.beginRound(session.id, "second");
    store.fail(session.id, "late first failure", undefined, 1);
    expect(session.status).toBe("running");
    expect(session.result).toBeUndefined();
    store.complete(
      session.id,
      { content: [{ type: "text", text: "second" }] },
      undefined,
      2,
    );
    expect(new SessionStore({ directory }).get(session.id)).toMatchObject({
      round: 2,
      status: "completed",
      codexSessionId: "sample-thread",
      result: { content: [{ type: "text", text: "second" }] },
    });
  });

  it("keeps terminal status when a stale finalizer arrives", () => {
    const store = new SessionStore({ directory });
    const session = store.create({
      toolName: "codex",
      prompt: "perform a task",
    });
    store.complete(
      session.id,
      { content: [{ type: "text", text: "done" }] },
      "codex-thread",
    );

    store.fail(session.id, "late failure");

    expect(store.get(session.id)?.status).toBe("completed");
    expect(store.get(session.id)?.error).toBeUndefined();
  });

  it("rejects a stale answer after completion without reverting status", async () => {
    const store = new SessionStore({ directory });
    const session = store.create({
      toolName: "codex",
      prompt: "perform a task",
    });
    const ask = store.ask(session.id, { message: "Which option?" });
    store.complete(
      session.id,
      { content: [{ type: "text", text: "done" }] },
      "codex-thread",
    );

    await expect(ask.response).rejects.toThrow(/completed before/);
    expect(() => store.answer(session.id, "option one")).toThrow(/completed/);
    expect(store.get(session.id)?.status).toBe("completed");
  });

  it("prunes expired terminal records at startup but retains active records", () => {
    writeRawRecord("expired", "failed", "2020-01-01T00:00:00.000Z");
    writeRawRecord("active", "running", "2020-01-01T00:00:00.000Z", {
      ownerPid: process.pid,
    });

    const store = new SessionStore({
      directory,
      ownerAlive: (session) => session.id === "active",
      retention: { maxAgeDays: 1, maxRecords: 10, protectRecentDays: 1 },
    });

    expect(store.get("expired")).toBeUndefined();
    expect(store.get("active")?.status).toBe("running");
    expect(fs.existsSync(path.join(directory, "expired.json"))).toBe(false);
  });

  it("refreshes a settled record after another store begins a round", () => {
    const first = new SessionStore({ directory });
    const session = first.create({ toolName: "worker", prompt: "first" });
    first.complete(
      session.id,
      { content: [{ type: "text", text: "first" }] },
      "sample-thread",
    );
    const observer = new SessionStore({ directory });

    first.beginRound(session.id, "second");

    expect(observer.get(session.id)).toMatchObject({
      status: "running",
      prompt: "second",
      round: 2,
    });
  });

  it("refreshes an externally owned live record after it completes", () => {
    const owner = new SessionStore({ directory });
    const session = owner.create({ toolName: "worker", prompt: "first" });
    const observer = new SessionStore({
      directory,
      ownerAlive: () => true,
    });

    owner.complete(
      session.id,
      { content: [{ type: "text", text: "done" }] },
      "sample-thread",
    );

    expect(observer.get(session.id)?.status).toBe("completed");
  });

  it("does not interrupt a round another store resumed", () => {
    const first = new SessionStore({ directory });
    const session = first.create({ toolName: "worker", prompt: "first" });
    first.complete(
      session.id,
      { content: [{ type: "text", text: "done" }] },
      "sample-thread",
    );
    const second = new SessionStore({ directory });
    second.beginRound(session.id, "second");

    expect(first.get(session.id)?.round).toBe(2);
    first.interruptOwned();

    expect(second.get(session.id)).toMatchObject({
      round: 2,
      status: "running",
    });
  });

  it("rejects continuation while another record operation owns the lock", () => {
    const store = new SessionStore({ directory });
    const session = store.create({ toolName: "worker", prompt: "first" });
    store.complete(
      session.id,
      { content: [{ type: "text", text: "first" }] },
      "sample-thread",
    );
    const file = path.join(directory, `${session.id}.json`);

    const locked = withRecordFileLock(file, () => {
      expect(() => store.beginRound(session.id, "second")).toThrow(/busy/);
      return true;
    });

    expect(locked).toEqual({ acquired: true, value: true });
    expect(store.get(session.id)?.status).toBe("completed");
  });

  it("rereads the public record after protection and before beginning a round", () => {
    const first = new SessionStore({ directory });
    const session = first.create({ toolName: "worker", prompt: "first" });
    first.complete(
      session.id,
      { content: [{ type: "text", text: "done" }] },
      "sample-thread",
    );
    const second = new SessionStore({ directory });
    const file = path.join(directory, `${session.id}.json`);
    const linkSync = fs.linkSync.bind(fs);
    let interleaved = false;
    vi.spyOn(fs, "linkSync").mockImplementation((existing, newLink) => {
      linkSync(existing, newLink);
      if (
        !interleaved &&
        existing === file &&
        String(newLink).includes("retention-protection")
      ) {
        interleaved = true;
        second.beginRound(session.id, "second");
      }
    });

    expect(() => first.beginRound(session.id, "competing")).toThrow(/running/);
    expect(JSON.parse(readRawRecord(session.id))).toMatchObject({
      round: 2,
      prompt: "second",
      status: "running",
    });
  });

  it("stops only the current live round and rejects its pending question", async () => {
    const store = new SessionStore({ directory });
    const session = store.create({ toolName: "worker", prompt: "first" });
    const ask = store.ask(session.id, { message: "Choose an option." });

    store.stop(session.id, 1);

    await expect(ask.response).rejects.toThrow(/stopped before/);
    expect(session).toMatchObject({
      status: "stopped",
      pendingAskId: undefined,
      error: "The Codex session stopped before completion.",
    });
    expect(store.fail(session.id, "late", undefined, 1).status).toBe("stopped");
  });

  it("ignores a stop finalizer from an earlier round", () => {
    const store = new SessionStore({ directory });
    const session = store.create({ toolName: "worker", prompt: "first" });
    store.complete(
      session.id,
      { content: [{ type: "text", text: "first" }] },
      "sample-thread",
      1,
    );
    store.beginRound(session.id, "second");

    store.stop(session.id, 1);

    expect(session.status).toBe("running");
    expect(session.round).toBe(2);
  });

  it("rejects a stale round write without replacing the newer record", () => {
    const store = new SessionStore({ directory });
    const session = store.create({ toolName: "worker", prompt: "first" });
    const newer = {
      ...session,
      round: 2,
      prompt: "second",
      ownerInstanceId: "external-owner",
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(directory, `${session.id}.json`),
      JSON.stringify(newer),
      { mode: 0o600 },
    );

    expect(() => store.fail(session.id, "late failure", undefined, 1)).toThrow(
      /changed in another server/,
    );
    expect(JSON.parse(readRawRecord(session.id))).toMatchObject({
      round: 2,
      prompt: "second",
      status: "running",
    });
  });

  it("rejects path separators before resolving a record file", () => {
    const outsideId = `${path.basename(directory)}-outside`;
    const outside = path.join(directory, "..", `${outsideId}.json`);
    const timestamp = new Date().toISOString();
    fs.writeFileSync(
      outside,
      JSON.stringify({
        id: `../${outsideId}`,
        toolName: "worker",
        prompt: "sample",
        status: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
      }),
    );

    expect(
      new SessionStore({ directory }).get(`../${outsideId}`),
    ).toBeUndefined();
    expect(fs.existsSync(outside)).toBe(true);

    fs.rmSync(outside);
  });

  it("ignores a valid record whose filename does not match its id", () => {
    writeRawRecord("actual", "completed", new Date().toISOString());
    fs.renameSync(
      path.join(directory, "actual.json"),
      path.join(directory, "different.json"),
    );

    const store = new SessionStore({ directory });

    expect(store.sessions).toHaveLength(0);
  });

  function writeRawRecord(
    id: string,
    status: string,
    updatedAt: string,
    extra: Record<string, unknown> = {},
  ): void {
    fs.writeFileSync(
      path.join(directory, `${id}.json`),
      JSON.stringify({
        id,
        toolName: "worker",
        prompt: "sample",
        status,
        createdAt: updatedAt,
        updatedAt,
        messages: [],
        ...extra,
      }),
      { mode: 0o600 },
    );
  }

  function readRawRecord(id: string): string {
    return fs.readFileSync(path.join(directory, `${id}.json`), "utf8");
  }
});
