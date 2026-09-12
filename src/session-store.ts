import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProcessAlive, processStartToken } from "./process-liveness.js";
import {
  DEFAULT_RETENTION_POLICY,
  pruneSessionRecords,
  recoverRetentionArtifacts,
  withProtectedRecordFile,
  withRecordFileLock,
  type RetentionPolicy,
} from "./retention.js";

export type SessionStatus =
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped";

export type SessionMessage = {
  id: string;
  type: "ask" | "notify";
  message: string;
  context?: string;
  topic?: string;
  createdAt: string;
  answeredAt?: string;
  response?: string;
};

export type SessionRecord = {
  id: string;
  toolName: string;
  prompt: string;
  model?: string;
  cwd?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  codexSessionId?: string;
  round?: number;
  result?: CallToolResult;
  error?: string;
  messages: SessionMessage[];
  pendingAskId?: string;
  ownerPid?: number;
  ownerStartToken?: string;
  ownerInstanceId?: string;
};

type PendingAskResolver = {
  resolve(response: string): void;
  reject(error: Error): void;
};

export type SessionStoreOptions = {
  directory?: string;
  persistent?: boolean;
  ownerAlive?: (session: SessionRecord) => boolean;
  retention?: RetentionPolicy;
};

const LIVE_STATUSES = new Set<SessionStatus>(["running", "waiting_for_input"]);
const TERMINAL_STATUSES = new Set<SessionStatus>([
  "completed",
  "failed",
  "interrupted",
  "stopped",
]);

export function sessionStoreDir(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return (
    process.env.ASYNC_CODEX_MCP_SESSION_DIR ??
    path.join(stateHome, "async-codex-mcp", "sessions")
  );
}

export class SessionStore {
  readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingAskResolvers = new Map<string, PendingAskResolver>();
  private readonly ownedRounds = new Map<
    string,
    { round: number; ownerInstanceId: string }
  >();
  private readonly instanceId = crypto.randomUUID();
  private readonly directory: string;
  private readonly persistent: boolean;
  private readonly ownerAlive: (session: SessionRecord) => boolean;
  private readonly retention: RetentionPolicy;

  // Invoked after every mutation; the server uses this to persist a
  // snapshot that the plugin's Stop hook reads out-of-process.
  onChange?: (store: SessionStore) => void;

  constructor(options: SessionStoreOptions = {}) {
    this.directory = options.directory ?? sessionStoreDir();
    this.persistent = options.persistent ?? true;
    this.ownerAlive = options.ownerAlive ?? isSessionOwnerAlive;
    this.retention = options.retention ?? DEFAULT_RETENTION_POLICY;
    if (this.persistent) {
      recoverRetentionArtifacts(this.directory);
      this.load();
      this.prune();
    }
  }

  create(
    input: Pick<SessionRecord, "toolName" | "prompt" | "model" | "cwd">,
  ): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      ...input,
      id: crypto.randomUUID(),
      status: "running",
      round: 1,
      createdAt: now,
      updatedAt: now,
      messages: [],
      ownerPid: process.pid,
      ownerStartToken: processStartToken(process.pid),
      ownerInstanceId: this.instanceId,
    };
    this.sessions.set(session.id, session);
    this.claimOwnership(session);
    this.changed(session);
    if (this.persistent) this.prune();
    return session;
  }

  get(id: string): SessionRecord | undefined {
    if (!isSafeRecordId(id)) return undefined;
    if (this.persistent) {
      this.refreshExternal(id);
    }
    return this.sessions.get(id);
  }

  beginRound(id: string, prompt: string, cwd?: string): SessionRecord {
    if (!this.persistent) {
      const session = this.require(id);
      this.prepareRound(session, prompt, cwd);
      this.claimOwnership(session);
      this.changed(session);
      return session;
    }

    const file = this.recordPath(id);
    const protectedRecord = withProtectedRecordFile(file, (protectedFile) =>
      withRecordFileLock(file, () => {
        // Another writer can replace the public path after protection is
        // acquired but before this lock. The public record is authoritative
        // once the lock is held; protection is only the prune-race fallback.
        const session = this.readRecord(file) ?? this.readRecord(protectedFile);
        if (!session || session.id !== id) {
          throw new Error(`Unknown session: ${id}`);
        }
        this.assertContinuable(session);
        this.prepareRound(session, prompt, cwd);
        this.persistUnlocked(session);
        return session;
      }),
    );
    if (!protectedRecord.protected) {
      throw new Error(`Unknown session: ${id}`);
    }
    if (!protectedRecord.value.acquired) {
      throw new Error(`Session ${id} is busy; retry the continuation.`);
    }

    const current = protectedRecord.value.value;
    const cached = this.sessions.get(id);
    const session = cached ? synchronizeRecord(cached, current) : current;
    this.sessions.set(id, session);
    this.claimOwnership(session);
    this.onChange?.(this);
    this.prune();
    return session;
  }

  ownedSessions(): SessionRecord[] {
    return [...this.ownedRounds].flatMap(([id, ownership]) => {
      const session = this.sessions.get(id);
      return session && this.matchesOwnership(session, ownership)
        ? [session]
        : [];
    });
  }

  interruptOwned(): void {
    for (const session of this.ownedSessions()) {
      if (!LIVE_STATUSES.has(session.status)) continue;
      this.rejectPendingAsk(
        session,
        `Session ${session.id} was interrupted because the MCP server stopped.`,
      );
      session.status = "interrupted";
      session.error =
        "The MCP server stopped before this session reached a terminal state.";
      session.updatedAt = new Date().toISOString();
      this.changed(session);
    }
  }

  update(
    id: string,
    patch: Partial<Omit<SessionRecord, "id" | "createdAt">>,
  ): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      throw new Error(`Session ${id} is ${session.status}; terminal records are immutable outside continuation.`);
    }
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.changed(session);
    return session;
  }

  complete(
    id: string,
    result: CallToolResult,
    codexSessionId?: string,
    round?: number,
  ): SessionRecord {
    const session = this.require(id);
    if (
      (round !== undefined && round !== (session.round ?? 1)) ||
      TERMINAL_STATUSES.has(session.status)
    )
      return session;
    this.rejectPendingAsk(
      session,
      `Session ${id} completed before the pending question was answered.`,
    );
    session.status = "completed";
    session.result = result;
    session.codexSessionId = codexSessionId ?? session.codexSessionId;
    session.updatedAt = new Date().toISOString();
    this.changed(session);
    return session;
  }

  fail(
    id: string,
    error: string,
    result?: CallToolResult,
    round?: number,
  ): SessionRecord {
    const session = this.require(id);
    if (
      (round !== undefined && round !== (session.round ?? 1)) ||
      TERMINAL_STATUSES.has(session.status)
    )
      return session;
    this.rejectPendingAsk(
      session,
      `Session ${id} failed before the pending question was answered: ${error}`,
    );
    session.status = "failed";
    session.error = error;
    session.result = result;
    session.updatedAt = new Date().toISOString();
    this.changed(session);
    return session;
  }

  stop(id: string, round?: number): SessionRecord {
    const session = this.require(id);
    if (
      (round !== undefined && round !== (session.round ?? 1)) ||
      TERMINAL_STATUSES.has(session.status)
    ) {
      return session;
    }
    this.rejectPendingAsk(
      session,
      `Session ${id} stopped before the pending question was answered.`,
    );
    session.status = "stopped";
    session.error = "The Codex session stopped before completion.";
    session.updatedAt = new Date().toISOString();
    this.changed(session);
    return session;
  }

  notify(
    sessionId: string,
    input: { message: string; topic?: string },
  ): SessionMessage {
    const session = this.require(sessionId);
    if (TERMINAL_STATUSES.has(session.status)) {
      throw new Error(`Session ${sessionId} is ${session.status}; it cannot send another notification.`);
    }
    const now = new Date().toISOString();
    const message: SessionMessage = {
      id: crypto.randomUUID(),
      type: "notify",
      message: input.message,
      topic: input.topic,
      createdAt: now,
    };
    session.messages.push(message);
    session.updatedAt = now;
    this.changed(session);
    return message;
  }

  ask(
    sessionId: string,
    input: { message: string; context?: string },
  ): { message: SessionMessage; response: Promise<string> } {
    const session = this.require(sessionId);
    if (TERMINAL_STATUSES.has(session.status)) {
      throw new Error(
        `Session ${sessionId} is ${session.status}; it cannot ask another question.`,
      );
    }
    if (session.pendingAskId) {
      throw new Error(`Session ${sessionId} is already waiting for input.`);
    }

    const now = new Date().toISOString();
    const message: SessionMessage = {
      id: crypto.randomUUID(),
      type: "ask",
      message: input.message,
      context: input.context,
      createdAt: now,
    };
    session.messages.push(message);
    session.pendingAskId = message.id;
    session.status = "waiting_for_input";
    session.updatedAt = now;

    const response = new Promise<string>((resolve, reject) => {
      this.pendingAskResolvers.set(message.id, { resolve, reject });
    });
    this.changed(session);
    return { message, response };
  }

  answer(sessionId: string, response: string): SessionMessage {
    const session = this.require(sessionId);
    if (session.status !== "waiting_for_input" || !session.pendingAskId) {
      throw new Error(
        `Session ${sessionId} is ${session.status}; only a live waiting_for_input session can be answered.`,
      );
    }

    const message = session.messages.find(
      (item) => item.id === session.pendingAskId,
    );
    if (!message) {
      throw new Error(`Session ${sessionId} pending question was not found.`);
    }

    const resolver = this.pendingAskResolvers.get(message.id);
    if (!resolver) {
      throw new Error(
        `Session ${sessionId} no longer has a live pending question.`,
      );
    }

    const now = new Date().toISOString();
    message.response = response;
    message.answeredAt = now;
    session.pendingAskId = undefined;
    session.status = "running";
    session.updatedAt = now;

    this.pendingAskResolvers.delete(message.id);
    resolver.resolve(response);
    this.changed(session);
    return message;
  }

  private load(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.directory);
    } catch {
      return;
    }

    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      try {
        const value = JSON.parse(
          fs.readFileSync(path.join(this.directory, entry), "utf8"),
        ) as unknown;
        let session = parseSessionRecord(value, entry.slice(0, -5));
        if (!session) continue;
        if (LIVE_STATUSES.has(session.status) && !this.ownerAlive(session)) {
          session = this.recoverInterrupted(session) ?? session;
        }
        this.sessions.set(session.id, session);
      } catch {
        // One malformed record must not prevent other resumable sessions loading.
      }
    }
  }

  private changed(session: SessionRecord): void {
    if (this.persistent) this.persist(session);
    this.onChange?.(this);
    if (this.persistent && TERMINAL_STATUSES.has(session.status)) this.prune();
  }

  private persist(session: SessionRecord): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.recordPath(session.id);
    // Only the active round owner writes transitions. Publishing completion is
    // what permits a new owner to resume; observers and cleanup must not block
    // this publication. Atomic rename also preserves writes during quarantine.
    const current = this.readRecord(file);
    if (current && !this.canOverwrite(current, session)) {
      synchronizeRecord(session, current);
      this.reconcileOwnership(session);
      throw new Error(
        `Session ${session.id} changed in another server; retry the operation.`,
      );
    }
    this.persistUnlocked(session);
  }

  private persistUnlocked(session: SessionRecord): void {
    const file = this.recordPath(session.id);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(session), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  }

  private recoverInterrupted(
    inspected: SessionRecord,
  ): SessionRecord | undefined {
    const file = this.recordPath(inspected.id);
    const locked = withRecordFileLock(file, () =>
      withProtectedRecordFile(file, (protectedFile) => {
        const current = this.readRecord(protectedFile);
        if (!current || current.id !== inspected.id) return undefined;
        if (!LIVE_STATUSES.has(current.status) || this.ownerAlive(current)) {
          return current;
        }
        current.status = "interrupted";
        current.pendingAskId = undefined;
        current.error =
          "The MCP server stopped before this session reached a terminal state.";
        current.updatedAt = new Date().toISOString();
        this.persistUnlocked(current);
        return current;
      }),
    );
    return locked.acquired && locked.value.protected
      ? locked.value.value
      : undefined;
  }

  private refreshExternal(id: string): void {
    const cached = this.sessions.get(id);
    if (
      cached &&
      this.ownedRounds.has(id) &&
      LIVE_STATUSES.has(cached.status)
    ) {
      return;
    }
    const file = this.recordPath(id);
    // Atomic reads retain their opened inode through rename. Recovery is only
    // needed on a missing/unreadable path, not for each status request.
    let current = this.readRecord(file);
    if (!current) {
      const protectedRecord = withProtectedRecordFile(file, (protectedFile) => this.readRecord(protectedFile));
      if (!protectedRecord.protected) {
        if (!fs.existsSync(file)) {
          this.sessions.delete(id);
          this.ownedRounds.delete(id);
        }
        return;
      }
      current = protectedRecord.value;
    }
    if (current?.id === id) {
      const cachedRecord = this.sessions.get(id);
      this.sessions.set(
        id,
        cachedRecord ? synchronizeRecord(cachedRecord, current) : current,
      );
      this.reconcileOwnership(current);
    }
  }

  private readRecord(file: string): SessionRecord | undefined {
    try {
      return parseSessionRecord(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return undefined;
    }
  }

  private recordPath(id: string): string {
    if (!isSafeRecordId(id)) throw new Error(`Unknown session: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  private prune(): void {
    const { removedIds } = pruneSessionRecords({
      directory: this.directory,
      policy: this.retention,
    });
    for (const id of removedIds) {
      this.sessions.delete(id);
      this.ownedRounds.delete(id);
    }
  }

  private assertContinuable(session: SessionRecord): void {
    if (session.status !== "completed") {
      throw new Error(
        `Session ${session.id} is ${session.status}; only completed sessions can be continued.`,
      );
    }
    if (!session.codexSessionId) {
      throw new Error(
        `Session ${session.id} did not expose a Codex session id.`,
      );
    }
  }

  private prepareRound(
    session: SessionRecord,
    prompt: string,
    cwd?: string,
  ): void {
    this.assertContinuable(session);
    session.round = (session.round ?? 1) + 1;
    session.prompt = prompt;
    session.cwd = cwd ?? session.cwd;
    session.status = "running";
    session.result = undefined;
    session.error = undefined;
    session.messages = [];
    session.pendingAskId = undefined;
    session.ownerPid = process.pid;
    session.ownerStartToken = processStartToken(process.pid);
    session.ownerInstanceId = this.instanceId;
    session.updatedAt = new Date().toISOString();
  }

  private claimOwnership(session: SessionRecord): void {
    this.ownedRounds.set(session.id, {
      round: session.round ?? 1,
      ownerInstanceId: this.instanceId,
    });
  }

  private matchesOwnership(
    session: SessionRecord,
    ownership: { round: number; ownerInstanceId: string },
  ): boolean {
    return (
      (session.round ?? 1) === ownership.round &&
      session.ownerInstanceId === ownership.ownerInstanceId
    );
  }

  private reconcileOwnership(session: SessionRecord): void {
    const ownership = this.ownedRounds.get(session.id);
    if (ownership && !this.matchesOwnership(session, ownership)) {
      this.ownedRounds.delete(session.id);
    }
  }

  private canOverwrite(
    current: SessionRecord,
    replacement: SessionRecord,
  ): boolean {
    if ((current.round ?? 1) !== (replacement.round ?? 1)) return false;
    if (
      current.ownerInstanceId &&
      replacement.ownerInstanceId &&
      current.ownerInstanceId !== replacement.ownerInstanceId
    ) {
      return false;
    }
    return true;
  }

  private rejectPendingAsk(session: SessionRecord, reason: string): void {
    if (!session.pendingAskId) return;
    const resolver = this.pendingAskResolvers.get(session.pendingAskId);
    this.pendingAskResolvers.delete(session.pendingAskId);
    session.pendingAskId = undefined;
    resolver?.reject(new Error(reason));
  }

  private require(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }
}

function parseSessionRecord(
  value: unknown,
  expectedId?: string,
): SessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<SessionRecord>;
  if (
    typeof record.id !== "string" ||
    (expectedId !== undefined && record.id !== expectedId) ||
    !isSafeRecordId(record.id) ||
    typeof record.toolName !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.status !== "string" ||
    !isSessionStatus(record.status) ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !Array.isArray(record.messages)
  ) {
    return undefined;
  }
  return record as SessionRecord;
}

function isSafeRecordId(id: string): boolean {
  return (
    id.length > 0 &&
    id !== "." &&
    id !== ".." &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0")
  );
}

function isSessionStatus(value: string): value is SessionStatus {
  return (
    value === "running" ||
    value === "waiting_for_input" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "stopped"
  );
}

function isSessionOwnerAlive(session: SessionRecord): boolean {
  if (!session.ownerPid) return false;
  return isProcessAlive(session.ownerPid, session.ownerStartToken);
}

function synchronizeRecord(
  target: SessionRecord,
  source: SessionRecord,
): SessionRecord {
  for (const key of Object.keys(target) as Array<keyof SessionRecord>) {
    if (!(key in source)) {
      (target as Record<keyof SessionRecord, unknown>)[key] = undefined;
    }
  }
  return Object.assign(target, source);
}
