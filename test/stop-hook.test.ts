import { describe, expect, it } from "vitest";
import type { StateFile } from "../src/state-file.js";
import { buildWatcherCommand, evaluateStopHook } from "../src/stop-hook.js";
import type { WatcherFile } from "../src/watcher-file.js";

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
        notifications: [],
      },
    ],
    ...overrides,
  };
}

function watcherFile(overrides: Partial<WatcherFile> = {}): WatcherFile {
  return {
    watcherPid: 5678,
    claudeSessionId: "session-a",
    ancestorPids: [100],
    startedAt: new Date().toISOString(),
    coverage: { scope: "conversation" },
    ...overrides,
  };
}

const alive = () => true;
const dead = () => false;
const noAncestors = () => new Set<number>();
const watchCommand = 'node "/plugin/dist/bundle/codex-watch-cli.js"';

describe("evaluateStopHook", () => {
  it("blocks a running session with no watcher and tells Claude how to start one", () => {
    const decision = evaluateStopHook(
      [stateFile()],
      [],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision?.decision).toBe("block");
    expect(decision?.reason).toContain("s1");
    expect(decision?.reason).toContain(watchCommand);
  });

  it("falls back to process ancestry when session ids do not match", () => {
    const decision = evaluateStopHook(
      [stateFile({ claudeSessionId: "stale-after-clear" })],
      [],
      { sessionId: "session-b", ancestors: () => new Set([100]) },
      watchCommand,
      alive,
    );
    expect(decision?.decision).toBe("block");
  });

  it("ignores sessions from other Claude sessions", () => {
    const decision = evaluateStopHook(
      [stateFile({ claudeSessionId: "someone-else", claudePid: 999 })],
      [],
      { sessionId: "session-b", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision).toBeUndefined();
  });

  it("ignores state files whose server process is gone", () => {
    const decision = evaluateStopHook(
      [stateFile()],
      [],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      dead,
    );
    expect(decision).toBeUndefined();
  });

  it("allows stopping when all sessions are settled", () => {
    const settled = stateFile();
    settled.sessions[0].status = "completed";
    const decision = evaluateStopHook(
      [settled],
      [],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision).toBeUndefined();
  });

  it("surfaces the pending question for waiting sessions even if a watcher is running", () => {
    const waiting = stateFile();
    waiting.sessions[0].status = "waiting_for_input";
    waiting.sessions[0].pendingAsk = "Which target?";
    const decision = evaluateStopHook(
      [waiting],
      [watcherFile()],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision?.reason).toContain("Which target?");
    expect(decision?.reason).toContain("answer-session");
  });

  it("allows stopping when a live watcher matches the session id", () => {
    const decision = evaluateStopHook(
      [stateFile()],
      [watcherFile()],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision).toBeUndefined();
  });

  it("allows stopping when a live watcher matches by ancestry", () => {
    const decision = evaluateStopHook(
      [stateFile({ claudeSessionId: "stale-after-clear" })],
      [watcherFile({ claudeSessionId: "stale-after-clear" })],
      { sessionId: "session-b", ancestors: () => new Set([100]) },
      watchCommand,
      alive,
    );
    expect(decision).toBeUndefined();
  });

  it("ignores a watcher whose process is dead", () => {
    const decision = evaluateStopHook(
      [stateFile()],
      [watcherFile()],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      (pid) => pid !== 5678,
    );
    expect(decision?.decision).toBe("block");
  });

  it("ignores a watcher registered for a different session", () => {
    const decision = evaluateStopHook(
      [stateFile()],
      [watcherFile({ claudeSessionId: "someone-else", ancestorPids: [999] })],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision?.decision).toBe("block");
  });

  it("does not let a session-scoped watcher cover a sibling session", () => {
    const file = stateFile();
    file.sessions.push({
      ...file.sessions[0],
      id: "s2",
    });
    const decision = evaluateStopHook(
      [file],
      [watcherFile({ coverage: { scope: "session", sessionId: "s1" } })],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision?.reason).not.toContain("s1 (");
    expect(decision?.reason).toContain("s2 (");
  });

  it("allows independent session-scoped watchers to cover every running session", () => {
    const file = stateFile();
    file.sessions.push({
      ...file.sessions[0],
      id: "s2",
    });
    const decision = evaluateStopHook(
      [file],
      [
        watcherFile({
          watcherPid: 5678,
          coverage: { scope: "session", sessionId: "s1" },
        }),
        watcherFile({
          watcherPid: 5679,
          coverage: { scope: "session", sessionId: "s2" },
        }),
      ],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      alive,
    );
    expect(decision).toBeUndefined();
  });

  it("rejects stale server and watcher identities even when their PIDs exist", () => {
    const identityAware = (_pid: number, token?: string) =>
      token !== "stale-token";
    expect(
      evaluateStopHook(
        [stateFile({ serverStartToken: "stale-token" })],
        [],
        { sessionId: "session-a", ancestors: noAncestors },
        watchCommand,
        identityAware,
      ),
    ).toBeUndefined();

    const decision = evaluateStopHook(
      [stateFile({ serverStartToken: "live-token" })],
      [
        watcherFile({
          watcherStartToken: "stale-token",
          coverage: { scope: "conversation" },
        }),
      ],
      { sessionId: "session-a", ancestors: noAncestors },
      watchCommand,
      identityAware,
    );
    expect(decision?.decision).toBe("block");
  });
});

describe("buildWatcherCommand", () => {
  it("uses the exact executable and safely quotes plugin paths", () => {
    expect(
      buildWatcherCommand(
        "/node path/bin/node",
        "/plugin's cache/codex-watch-cli.js",
      ),
    ).toBe("'/node path/bin/node' '/plugin'\\''s cache/codex-watch-cli.js'");
  });
});
