import { readStateFiles, type StateFileSession } from "./state-file.js";

export const ACTIVE_STATUSES = new Set(["running", "waiting_for_input"]);

export function matchingSessions(sessionId: string | undefined, ancestors: Set<number>): StateFileSession[] {
  return readStateFiles()
    .filter((file) => (sessionId && file.claudeSessionId === sessionId) || ancestors.has(file.claudePid))
    .flatMap((file) => file.sessions);
}

export function describeStatus(session: StateFileSession): string {
  if (session.status === "waiting_for_input") {
    const question = session.pendingAsk ? `: "${session.pendingAsk}"` : "";
    return `session ${session.id} (${session.toolName}) is waiting for input${question}`;
  }
  return `session ${session.id} (${session.toolName}) is ${session.status}`;
}

// waiting_for_input always needs Claude back, regardless of other sessions: only Claude
// can call answer-session, so the watcher should not keep polling in the background.
export function needsAttention(sessions: StateFileSession[]): boolean {
  return sessions.some((session) => session.status === "waiting_for_input");
}

export function stillRunning(sessions: StateFileSession[]): boolean {
  return sessions.some((session) => session.status === "running");
}
