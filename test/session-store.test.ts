import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";

describe("SessionStore persistence", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "async-codex-session-store-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("rehydrates completed sessions for continuation", () => {
    const original = new SessionStore({ directory });
    const session = original.create({ toolName: "codex", prompt: "perform a task", cwd: "/tmp/workspace" });
    original.complete(session.id, { content: [{ type: "text", text: "done" }] }, "codex-thread");

    const recovered = new SessionStore({ directory }).get(session.id);

    expect(recovered).toEqual(
      expect.objectContaining({
        id: session.id,
        status: "completed",
        codexSessionId: "codex-thread",
        cwd: "/tmp/workspace",
      }),
    );
  });

  it.each(["running", "waiting_for_input"] as const)("recovers %s sessions as interrupted", (status) => {
    const original = new SessionStore({ directory });
    const session = original.create({ toolName: "codex", prompt: "perform a task" });
    if (status === "waiting_for_input") {
      void original.ask(session.id, { message: "Which option?" }).response.catch(() => undefined);
    }

    const recovered = new SessionStore({ directory }).get(session.id);

    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.pendingAskId).toBeUndefined();
    expect(recovered?.error).toMatch(/stopped before/);
  });

  it("ignores malformed records while loading valid sessions", () => {
    const original = new SessionStore({ directory });
    const session = original.create({ toolName: "codex", prompt: "perform a task" });
    original.complete(session.id, { content: [{ type: "text", text: "done" }] }, "codex-thread");
    fs.writeFileSync(path.join(directory, "malformed.json"), "{");

    const recovered = new SessionStore({ directory });

    expect(recovered.get(session.id)?.status).toBe("completed");
    expect(recovered.sessions).toHaveLength(1);
  });

  it("keeps terminal status when a stale finalizer arrives", () => {
    const store = new SessionStore({ directory });
    const session = store.create({ toolName: "codex", prompt: "perform a task" });
    store.complete(session.id, { content: [{ type: "text", text: "done" }] }, "codex-thread");

    store.fail(session.id, "late failure");

    expect(store.get(session.id)?.status).toBe("completed");
    expect(store.get(session.id)?.error).toBeUndefined();
  });

  it("rejects a stale answer after completion without reverting status", async () => {
    const store = new SessionStore({ directory });
    const session = store.create({ toolName: "codex", prompt: "perform a task" });
    const ask = store.ask(session.id, { message: "Which option?" });
    store.complete(session.id, { content: [{ type: "text", text: "done" }] }, "codex-thread");

    await expect(ask.response).rejects.toThrow(/completed before/);
    expect(() => store.answer(session.id, "option one")).toThrow(/completed/);
    expect(store.get(session.id)?.status).toBe("completed");
  });
});
