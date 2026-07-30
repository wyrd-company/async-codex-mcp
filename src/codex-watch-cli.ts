#!/usr/bin/env node
import { readStateFiles, type StateFileSession } from "./state-file.js";
import { ancestorPids } from "./stop-hook.js";
import { removeWatcherFile, writeWatcherFile } from "./watcher-file.js";

const ACTIVE_STATUSES = new Set(["running", "waiting_for_input"]);
const pollIntervalMs = Number(process.env.ASYNC_CODEX_MCP_WATCH_INTERVAL_MS ?? 10_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchingSessions(sessionId: string | undefined, ancestors: Set<number>): StateFileSession[] {
  return readStateFiles()
    .filter((file) => (sessionId && file.claudeSessionId === sessionId) || ancestors.has(file.claudePid))
    .flatMap((file) => file.sessions);
}

function describeStatus(session: StateFileSession): string {
  if (session.status === "waiting_for_input") {
    const question = session.pendingAsk ? `: "${session.pendingAsk}"` : "";
    return `session ${session.id} (${session.toolName}) is waiting for input${question}`;
  }
  return `session ${session.id} (${session.toolName}) is ${session.status}`;
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

  writeWatcherFile(ancestors);
  try {
    const lastStatus = new Map(sessions.map((session) => [session.id, session.status]));
    for (const session of active) console.log(`watching ${describeStatus(session)}`);

    while (active.length > 0) {
      await sleep(pollIntervalMs);
      sessions = matchingSessions(sessionId, ancestors);
      for (const session of sessions) {
        if (lastStatus.get(session.id) !== session.status) {
          lastStatus.set(session.id, session.status);
          console.log(describeStatus(session));
        }
      }
      active = sessions.filter((session) => ACTIVE_STATUSES.has(session.status));
    }

    console.log("All watched Codex sessions have settled.");
  } finally {
    removeWatcherFile();
  }
}

await main();
