#!/usr/bin/env node
import {
  ACTIVE_STATUSES,
  describeNotification,
  describeStatus,
  matchingSessions,
  needsAttention,
  parseWatchScope,
  stillRunning,
  unseenNotifications,
  WATCH_USAGE,
} from "./codex-watch.js";
import { ancestorPids } from "./stop-hook.js";
import { removeWatcherFile, writeWatcherFile } from "./watcher-file.js";

const pollIntervalMs = Number(
  process.env.ASYNC_CODEX_MCP_WATCH_INTERVAL_MS ?? 10_000,
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (
    process.argv
      .slice(2)
      .some((argument) => argument === "--help" || argument === "-h")
  ) {
    console.log(WATCH_USAGE);
    return;
  }
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  const ancestors = ancestorPids();
  const scope = parseWatchScope(process.argv.slice(2), sessionId, ancestors);

  let sessions = matchingSessions(scope);
  let active = sessions.filter((session) =>
    ACTIVE_STATUSES.has(session.status),
  );
  if (active.length === 0) {
    console.log("No active Codex sessions to watch.");
    return;
  }

  if (needsAttention(sessions)) {
    for (const session of active) console.log(describeStatus(session));
    for (const { session, notification } of unseenNotifications(
      sessions,
      new Set(),
    )) {
      console.log(describeNotification(session, notification));
    }
    console.log(
      "Answer the waiting session(s) now with the answer-session tool.",
    );
    return;
  }

  writeWatcherFile(
    ancestors,
    scope.kind === "session"
      ? { scope: "session", sessionId: scope.sessionId }
      : { scope: "conversation" },
  );
  try {
    const lastStatus = new Map(
      sessions.map((session) => [session.id, session.status]),
    );
    const seenNotifications = new Set<string>();
    for (const session of active)
      console.log(`watching ${describeStatus(session)}`);
    for (const { session, notification } of unseenNotifications(
      sessions,
      seenNotifications,
    )) {
      console.log(describeNotification(session, notification));
    }

    while (stillRunning(sessions) && !needsAttention(sessions)) {
      await sleep(pollIntervalMs);
      sessions = matchingSessions(scope);
      for (const session of sessions) {
        if (lastStatus.get(session.id) !== session.status) {
          lastStatus.set(session.id, session.status);
          console.log(describeStatus(session));
        }
      }
      for (const { session, notification } of unseenNotifications(
        sessions,
        seenNotifications,
      )) {
        console.log(describeNotification(session, notification));
      }
    }

    console.log(
      needsAttention(sessions)
        ? "Answer the waiting session(s) now with the answer-session tool. Restart this watcher afterwards if other sessions are still running."
        : "All watched Codex sessions have settled.",
    );
  } finally {
    removeWatcherFile();
  }
}

await main();
