import { describe, expect, it } from "vitest";
import type { StateFile } from "../src/state-file.js";
import { evaluateStopHook } from "../src/stop-hook.js";

function stateFile(overrides: Partial<StateFile> = {}): StateFile {
  return {
    serverPid: 1234,
    claudePid: 100,
    claudeSessionId: "session-a",
    updatedAt: new Date().toISOString(),
    sessions: [
      {
        id: "s1",
        toolName: "codex",
        status: "running",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

const alive = () => true;
const dead = () => false;
const noAncestors = () => new Set<number>();

describe("evaluateStopHook", () => {
  it("blocks when a running session belongs to the hook's Claude session id", () => {
    const decision = evaluateStopHook([stateFile()], { sessionId: "session-a", ancestors: noAncestors }, alive);
    expect(decision?.decision).toBe("block");
    expect(decision?.reason).toContain("s1");
    expect(decision?.reason).toContain("session-status");
  });

  it("falls back to process ancestry when session ids do not match", () => {
    const decision = evaluateStopHook(
      [stateFile({ claudeSessionId: "stale-after-clear" })],
      { sessionId: "session-b", ancestors: () => new Set([100]) },
      alive,
    );
    expect(decision?.decision).toBe("block");
  });

  it("ignores sessions from other Claude sessions", () => {
    const decision = evaluateStopHook(
      [stateFile({ claudeSessionId: "someone-else", claudePid: 999 })],
      { sessionId: "session-b", ancestors: noAncestors },
      alive,
    );
    expect(decision).toBeUndefined();
  });

  it("ignores state files whose server process is gone", () => {
    const decision = evaluateStopHook([stateFile()], { sessionId: "session-a", ancestors: noAncestors }, dead);
    expect(decision).toBeUndefined();
  });

  it("allows stopping when all sessions are settled", () => {
    const settled = stateFile();
    settled.sessions[0].status = "completed";
    const decision = evaluateStopHook([settled], { sessionId: "session-a", ancestors: noAncestors }, alive);
    expect(decision).toBeUndefined();
  });

  it("surfaces the pending question for waiting sessions", () => {
    const waiting = stateFile();
    waiting.sessions[0].status = "waiting_for_input";
    waiting.sessions[0].pendingAsk = "Which target?";
    const decision = evaluateStopHook([waiting], { sessionId: "session-a", ancestors: noAncestors }, alive);
    expect(decision?.reason).toContain("Which target?");
    expect(decision?.reason).toContain("answer-session");
  });
});
