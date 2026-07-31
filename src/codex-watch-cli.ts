#!/usr/bin/env node
import { ACTIVE_STATUSES, describeStatus, matchingSessions, needsAttention, stillRunning } from "./codex-watch.js";
import { ancestorPids } from "./stop-hook.js";
import { removeWatcherFile, writeWatcherFile } from "./watcher-file.js";

const pollIntervalMs = Number(process.env.ASYNC_CODEX_MCP_WATCH_INTERVAL_MS ?? 10_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  const ancestors = ancestorPids();

  let sessions = matchingSessions(sessionId, ancestors);
  let active = sessions.filter((session) => ACTIVE_STATUSES.has(session.status));
  if (active.length === 0) {
    console.log("No active Codex sessions to watch.");
    return;
  }

  if (needsAttention(sessions)) {
    for (const session of active) console.log(describeStatus(session));
    console.log("Answer the waiting session(s) now with the answer-session tool.");
    return;
  }

  writeWatcherFile(ancestors);
  try {
    const lastStatus = new Map(sessions.map((session) => [session.id, session.status]));
    for (const session of active) console.log(`watching ${describeStatus(session)}`);

    while (stillRunning(sessions) && !needsAttention(sessions)) {
      await sleep(pollIntervalMs);
      sessions = matchingSessions(sessionId, ancestors);
      for (const session of sessions) {
        if (lastStatus.get(session.id) !== session.status) {
          lastStatus.set(session.id, session.status);
          console.log(describeStatus(session));
        }
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
