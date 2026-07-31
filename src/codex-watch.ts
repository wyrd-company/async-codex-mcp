import { isPidAlive } from "./stop-hook.js";
import {
  readStateFiles,
  type StateFile,
  type StateFileNotification,
  type StateFileSession,
} from "./state-file.js";

export const ACTIVE_STATUSES = new Set(["running", "waiting_for_input"]);
export const WATCH_USAGE =
  "Usage: async-codex-mcp-watch [--session-id <async-session-id>]";

export type WatchScope =
  | { kind: "conversation"; claudeSessionId?: string; ancestors: Set<number> }
  | { kind: "session"; sessionId: string };

export function matchingSessions(
  scope: WatchScope,
  files: StateFile[] = readStateFiles(),
  pidAlive: (pid: number) => boolean = isPidAlive,
): StateFileSession[] {
  return files
    .filter((file) => pidAlive(file.serverPid))
    .filter((file) =>
      scope.kind === "session"
        ? file.sessions.some((session) => session.id === scope.sessionId)
        : (scope.claudeSessionId &&
            file.claudeSessionId === scope.claudeSessionId) ||
          scope.ancestors.has(file.claudePid),
    )
    .flatMap((file) => file.sessions)
    .filter(
      (session) =>
        scope.kind === "conversation" || session.id === scope.sessionId,
    );
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

export function describeNotification(
  session: StateFileSession,
  notification: StateFileNotification,
): string {
  const topic = notification.topic ? ` [${notification.topic}]` : "";
  return `notification from session ${session.id} (${session.toolName})${topic}: ${notification.message}`;
}

export function unseenNotifications(
  sessions: StateFileSession[],
  seen: Set<string>,
): Array<{ session: StateFileSession; notification: StateFileNotification }> {
  const unseen = sessions
    .flatMap((session) =>
      (session.notifications ?? []).map((notification) => ({
        session,
        notification,
      })),
    )
    .filter(({ notification }) => !seen.has(notification.id))
    .sort((left, right) =>
      left.notification.createdAt === right.notification.createdAt
        ? left.notification.id.localeCompare(right.notification.id)
        : left.notification.createdAt.localeCompare(
            right.notification.createdAt,
          ),
    );
  for (const { notification } of unseen) seen.add(notification.id);
  return unseen;
}

export function parseWatchScope(
  args: string[],
  claudeSessionId: string | undefined,
  ancestors: Set<number>,
): WatchScope {
  if (args.length === 0)
    return { kind: "conversation", claudeSessionId, ancestors };
  if (args.length === 2 && args[0] === "--session-id" && args[1]) {
    return { kind: "session", sessionId: args[1] };
  }
  throw new Error(WATCH_USAGE);
}
