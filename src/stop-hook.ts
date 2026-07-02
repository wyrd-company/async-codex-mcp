import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { StateFile, StateFileSession } from "./state-file.js";

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
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
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

export function evaluateStopHook(
  files: StateFile[],
  context: StopHookContext,
  pidAlive: (pid: number) => boolean = isPidAlive,
): StopHookDecision | undefined {
  let ancestors: Set<number> | undefined;
  const matchesSession = (file: StateFile) => {
    if (context.sessionId && file.claudeSessionId === context.sessionId) return true;
    ancestors ??= context.ancestors();
    return ancestors.has(file.claudePid);
  };

  const active = files
    .filter((file) => matchesSession(file) && pidAlive(file.serverPid))
    .flatMap((file) => file.sessions.filter((session) => ACTIVE_STATUSES.has(session.status)));

  if (active.length === 0) return undefined;

  const waiting = active.filter((session) => session.status === "waiting_for_input");
  const reason = [
    `Async Codex session${active.length === 1 ? "" : "s"} started from this conversation ${active.length === 1 ? "is" : "are"} still active:`,
    ...active.map(describe),
    "",
    waiting.length > 0
      ? "Answer the waiting session(s) now with the answer-session tool, then keep monitoring."
      : "Keep monitoring: wait (for example `sleep 30` via Bash), then check session-status, and repeat until each session completes or fails.",
    "When a session completes, read its result with session-status and report it. Only stop early if the user explicitly told you to abandon these sessions.",
  ].join("\n");

  return { decision: "block", reason };
}
