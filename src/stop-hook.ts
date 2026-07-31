import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { StateFile, StateFileSession } from "./state-file.js";
import type { WatcherFile } from "./watcher-file.js";

export type StopHookDecision = {
  decision: "block";
  reason: string;
};

const ACTIVE_STATUSES = new Set(["running", "waiting_for_input"]);

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parentPid(pid: number): number | undefined {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may contain spaces.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (Number.isInteger(ppid)) return ppid;
  } catch {
    // fall through to ps
  }
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const ppid = Number(result.stdout?.trim());
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

export function ancestorPids(startPid = process.pid): Set<number> {
  const ancestors = new Set<number>();
  let pid: number | undefined = startPid;
  for (let depth = 0; depth < 50 && pid && pid > 1; depth += 1) {
    pid = parentPid(pid);
    if (!pid || pid <= 1 || ancestors.has(pid)) break;
    ancestors.add(pid);
  }
  return ancestors;
}

export function buildWatcherCommand(
  executable: string,
  watcherCliPath: string,
): string {
  return `${shellQuote(executable)} ${shellQuote(watcherCliPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function describe(session: StateFileSession): string {
  if (session.status === "waiting_for_input") {
    const question = session.pendingAsk ? `: "${session.pendingAsk}"` : "";
    return `- ${session.id} (${session.toolName}) is waiting for input${question}`;
  }
  return `- ${session.id} (${session.toolName}) is running since ${session.createdAt}`;
}

export type StopHookContext = {
  // session_id from the hook's stdin payload; matched against the
  // CLAUDE_CODE_SESSION_ID the MCP server captured at spawn.
  sessionId?: string;
  // Fallback for id rotation (e.g. /clear keeps the Claude process and its
  // MCP server but issues a new session id): the hook's process ancestry
  // contains the Claude pid the server recorded as its parent.
  ancestors: () => Set<number>;
};

function matchesContext(
  claudeSessionId: string | undefined,
  claudePid: number,
  context: StopHookContext,
  ancestors: Set<number>,
): boolean {
  if (context.sessionId && claudeSessionId === context.sessionId) return true;
  return ancestors.has(claudePid);
}

function watcherMatchesContext(
  watcher: WatcherFile,
  context: StopHookContext,
  ancestors: Set<number>,
): boolean {
  if (context.sessionId && watcher.claudeSessionId === context.sessionId)
    return true;
  return watcher.ancestorPids.some((pid) => ancestors.has(pid));
}

function isCoveredByLiveWatcher(
  session: StateFileSession,
  watcherFiles: WatcherFile[],
  context: StopHookContext,
  ancestors: Set<number>,
  pidAlive: (pid: number) => boolean,
): boolean {
  return watcherFiles.some((watcher) => {
    if (!pidAlive(watcher.watcherPid)) return false;
    if (!watcherMatchesContext(watcher, context, ancestors)) return false;
    return (
      watcher.coverage.scope === "conversation" ||
      watcher.coverage.sessionId === session.id
    );
  });
}

export function evaluateStopHook(
  files: StateFile[],
  watcherFiles: WatcherFile[],
  context: StopHookContext,
  watcherCommand: string,
  pidAlive: (pid: number) => boolean = isPidAlive,
): StopHookDecision | undefined {
  let ancestors: Set<number> | undefined;
  const resolveAncestors = () => (ancestors ??= context.ancestors());

  const active = files
    .filter(
      (file) =>
        matchesContext(
          file.claudeSessionId,
          file.claudePid,
          context,
          resolveAncestors(),
        ) && pidAlive(file.serverPid),
    )
    .flatMap((file) =>
      file.sessions.filter((session) => ACTIVE_STATUSES.has(session.status)),
    );

  if (active.length === 0) return undefined;

  const waiting = active.filter(
    (session) => session.status === "waiting_for_input",
  );
  const uncovered = active.filter(
    (session) =>
      session.status === "running" &&
      !isCoveredByLiveWatcher(
        session,
        watcherFiles,
        context,
        resolveAncestors(),
        pidAlive,
      ),
  );
  if (waiting.length === 0 && uncovered.length === 0) {
    return undefined;
  }

  const reported = waiting.length > 0 ? active : uncovered;
  const reason = [
    `Async Codex session${reported.length === 1 ? "" : "s"} started from this conversation ${reported.length === 1 ? "is" : "are"} still active:`,
    ...reported.map(describe),
    "",
    waiting.length > 0
      ? "Answer the waiting session(s) now with the answer-session tool, then keep monitoring."
      : `No watcher covers these sessions yet. Start a conversation watcher in the background: \`${watcherCommand}\`. To cover only one, append \`--session-id <async-session-id>\`. Watchers print status and notify events; you'll be notified when they exit or via their output.`,
    "When a session completes, read its result with session-status and report it. Only stop early if the user explicitly told you to abandon these sessions.",
  ].join("\n");

  return { decision: "block", reason };
}
