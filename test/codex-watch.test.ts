import { describe, expect, it } from "vitest";
import { describeStatus, needsAttention, stillRunning } from "../src/codex-watch.js";
import type { StateFileSession } from "../src/state-file.js";

function session(overrides: Partial<StateFileSession> = {}): StateFileSession {
  return {
    id: "s1",
    toolName: "codex",
    status: "running",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("needsAttention", () => {
  it("is true when any session is waiting_for_input", () => {
    expect(needsAttention([session({ status: "running" }), session({ id: "s2", status: "waiting_for_input" })])).toBe(true);
  });

  it("is false when no session is waiting_for_input", () => {
    expect(needsAttention([session({ status: "running" }), session({ id: "s2", status: "completed" })])).toBe(false);
  });
});

describe("stillRunning", () => {
  it("is true when any session is running", () => {
    expect(stillRunning([session({ status: "completed" }), session({ id: "s2", status: "running" })])).toBe(true);
  });

  it("is false once no session is running", () => {
    expect(stillRunning([session({ status: "completed" }), session({ id: "s2", status: "waiting_for_input" })])).toBe(false);
  });
});

describe("describeStatus", () => {
  it("includes the pending question for waiting sessions", () => {
    const text = describeStatus(session({ status: "waiting_for_input", pendingAsk: "Which target?" }));
    expect(text).toContain("waiting for input");
    expect(text).toContain("Which target?");
  });

  it("describes other statuses plainly", () => {
    expect(describeStatus(session({ status: "completed" }))).toBe("session s1 (codex) is completed");
  });
});
