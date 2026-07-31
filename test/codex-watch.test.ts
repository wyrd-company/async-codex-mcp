import { describe, expect, it } from "vitest";
import {
  describeNotification,
  describeStatus,
  matchingSessions,
  needsAttention,
  parseWatchScope,
  stillRunning,
  unseenNotifications,
} from "../src/codex-watch.js";
import type { StateFile } from "../src/state-file.js";
import type { StateFileSession } from "../src/state-file.js";

function session(overrides: Partial<StateFileSession> = {}): StateFileSession {
  return {
    id: "s1",
    toolName: "codex",
    status: "running",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    notifications: [],
    ...overrides,
  };
}

describe("needsAttention", () => {
  it("is true when any session is waiting_for_input", () => {
    expect(
      needsAttention([
        session({ status: "running" }),
        session({ id: "s2", status: "waiting_for_input" }),
      ]),
    ).toBe(true);
  });

  it("is false when no session is waiting_for_input", () => {
    expect(
      needsAttention([
        session({ status: "running" }),
        session({ id: "s2", status: "completed" }),
      ]),
    ).toBe(false);
  });
});

describe("stillRunning", () => {
  it("is true when any session is running", () => {
    expect(
      stillRunning([
        session({ status: "completed" }),
        session({ id: "s2", status: "running" }),
      ]),
    ).toBe(true);
  });

  it("is false once no session is running", () => {
    expect(
      stillRunning([
        session({ status: "completed" }),
        session({ id: "s2", status: "waiting_for_input" }),
      ]),
    ).toBe(false);
  });
});

describe("describeStatus", () => {
  it("includes the pending question for waiting sessions", () => {
    const text = describeStatus(
      session({ status: "waiting_for_input", pendingAsk: "Which target?" }),
    );
    expect(text).toContain("waiting for input");
    expect(text).toContain("Which target?");
  });

  it("describes other statuses plainly", () => {
    expect(describeStatus(session({ status: "completed" }))).toBe(
      "session s1 (codex) is completed",
    );
  });
});

describe("matchingSessions", () => {
  const files: StateFile[] = [
    {
      serverPid: 10,
      claudePid: 100,
      claudeSessionId: "conversation-a",
      updatedAt: "2026-07-02T00:00:00.000Z",
      sessions: [session({ id: "live-a" }), session({ id: "live-b" })],
    },
    {
      serverPid: 20,
      claudePid: 100,
      claudeSessionId: "conversation-a",
      updatedAt: "2026-07-02T00:00:00.000Z",
      sessions: [session({ id: "ghost", status: "waiting_for_input" })],
    },
  ];

  it("filters dead servers before a conversation watcher evaluates attention", () => {
    const matched = matchingSessions(
      {
        kind: "conversation",
        claudeSessionId: "conversation-a",
        ancestors: new Set(),
      },
      files,
      (pid) => pid === 10,
    );
    expect(matched.map(({ id }) => id)).toEqual(["live-a", "live-b"]);
    expect(needsAttention(matched)).toBe(false);
  });

  it("selects exactly one live async session in session scope", () => {
    const matched = matchingSessions(
      { kind: "session", sessionId: "live-b" },
      files,
      (pid) => pid === 10,
    );
    expect(matched.map(({ id }) => id)).toEqual(["live-b"]);
  });

  it("does not surface a ghost ask in session scope", () => {
    expect(
      matchingSessions(
        { kind: "session", sessionId: "ghost" },
        files,
        (pid) => pid === 10,
      ),
    ).toEqual([]);
  });
});

describe("watcher notifications", () => {
  it("emits ordered notifications once per watcher process", () => {
    const sessions = [
      session({
        notifications: [
          {
            id: "n2",
            message: "second",
            createdAt: "2026-07-02T00:00:02.000Z",
          },
          {
            id: "n1",
            message: "first\nline two",
            topic: "approval",
            createdAt: "2026-07-02T00:00:01.000Z",
          },
        ],
      }),
    ];
    const seen = new Set<string>();
    const first = unseenNotifications(sessions, seen);
    expect(first.map(({ notification }) => notification.id)).toEqual([
      "n1",
      "n2",
    ]);
    expect(
      describeNotification(first[0].session, first[0].notification),
    ).toContain("[approval]: first\nline two");
    expect(unseenNotifications(sessions, seen)).toEqual([]);
  });
});

describe("parseWatchScope", () => {
  it("defaults to conversation scope", () => {
    expect(parseWatchScope([], "conversation-a", new Set([100]))).toEqual({
      kind: "conversation",
      claudeSessionId: "conversation-a",
      ancestors: new Set([100]),
    });
  });

  it("accepts one async session id", () => {
    expect(
      parseWatchScope(["--session-id", "session-a"], undefined, new Set()),
    ).toEqual({
      kind: "session",
      sessionId: "session-a",
    });
  });

  it("rejects invalid arguments", () => {
    expect(() => parseWatchScope(["--unknown"], undefined, new Set())).toThrow(
      /Usage/,
    );
  });
});
