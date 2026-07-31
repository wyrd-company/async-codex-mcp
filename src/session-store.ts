import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SessionStatus = "running" | "waiting_for_input" | "completed" | "failed" | "interrupted";

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
  result?: CallToolResult;
  error?: string;
  messages: SessionMessage[];
  pendingAskId?: string;
  ownerPid?: number;
  ownerStartToken?: string;
};

type PendingAskResolver = {
  resolve(response: string): void;
  reject(error: Error): void;
};

export type SessionStoreOptions = {
  directory?: string;
  persistent?: boolean;
  ownerAlive?: (session: SessionRecord) => boolean;
};

const LIVE_STATUSES = new Set<SessionStatus>(["running", "waiting_for_input"]);
const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "interrupted"]);

export function sessionStoreDir(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return process.env.ASYNC_CODEX_MCP_SESSION_DIR ?? path.join(stateHome, "async-codex-mcp", "sessions");
}

export class SessionStore {
  readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingAskResolvers = new Map<string, PendingAskResolver>();
  private readonly ownedSessionIds = new Set<string>();
  private readonly directory: string;
  private readonly persistent: boolean;
  private readonly ownerAlive: (session: SessionRecord) => boolean;

  // Invoked after every mutation; the server uses this to persist a
  // snapshot that the plugin's Stop hook reads out-of-process.
  onChange?: (store: SessionStore) => void;

  constructor(options: SessionStoreOptions = {}) {
    this.directory = options.directory ?? sessionStoreDir();
    this.persistent = options.persistent ?? true;
    this.ownerAlive = options.ownerAlive ?? isSessionOwnerAlive;
    if (this.persistent) this.load();
  }

  create(input: Pick<SessionRecord, "toolName" | "prompt" | "model" | "cwd">): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      ...input,
      id: crypto.randomUUID(),
      status: "running",
      createdAt: now,
      updatedAt: now,
      messages: [],
      ownerPid: process.pid,
      ownerStartToken: processStartToken(process.pid),
    };
    this.sessions.set(session.id, session);
    this.ownedSessionIds.add(session.id);
    this.changed(session);
    return session;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  ownedSessions(): SessionRecord[] {
    return [...this.ownedSessionIds].flatMap((id) => {
      const session = this.sessions.get(id);
      return session ? [session] : [];
    });
  }

  interruptOwned(): void {
    for (const session of this.ownedSessions()) {
      if (!LIVE_STATUSES.has(session.status)) continue;
      this.rejectPendingAsk(session, `Session ${session.id} was interrupted because the MCP server stopped.`);
      session.status = "interrupted";
      session.error = "The MCP server stopped before this session reached a terminal state.";
      session.updatedAt = new Date().toISOString();
      this.changed(session);
    }
  }

  update(id: string, patch: Partial<Omit<SessionRecord, "id" | "createdAt">>): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    if (TERMINAL_STATUSES.has(session.status) && patch.status && patch.status !== session.status) {
      throw new Error(`Session ${id} is ${session.status}; terminal sessions cannot transition to ${patch.status}.`);
    }
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.changed(session);
    return session;
  }

  complete(id: string, result: CallToolResult, codexSessionId?: string): SessionRecord {
    const session = this.require(id);
    if (TERMINAL_STATUSES.has(session.status)) return session;
    this.rejectPendingAsk(session, `Session ${id} completed before the pending question was answered.`);
    session.status = "completed";
    session.result = result;
    session.codexSessionId = codexSessionId;
    session.updatedAt = new Date().toISOString();
    this.changed(session);
    return session;
  }

  fail(id: string, error: string, result?: CallToolResult): SessionRecord {
    const session = this.require(id);
    if (TERMINAL_STATUSES.has(session.status)) return session;
    this.rejectPendingAsk(session, `Session ${id} failed before the pending question was answered: ${error}`);
    session.status = "failed";
    session.error = error;
    session.result = result;
    session.updatedAt = new Date().toISOString();
    this.changed(session);
    return session;
  }

  notify(sessionId: string, input: { message: string; topic?: string }): SessionMessage {
    const session = this.require(sessionId);
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

  ask(sessionId: string, input: { message: string; context?: string }): { message: SessionMessage; response: Promise<string> } {
    const session = this.require(sessionId);
    if (TERMINAL_STATUSES.has(session.status)) {
      throw new Error(`Session ${sessionId} is ${session.status}; it cannot ask another question.`);
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
      throw new Error(`Session ${sessionId} is ${session.status}; only a live waiting_for_input session can be answered.`);
    }

    const message = session.messages.find((item) => item.id === session.pendingAskId);
    if (!message) {
      throw new Error(`Session ${sessionId} pending question was not found.`);
    }

    const resolver = this.pendingAskResolvers.get(message.id);
    if (!resolver) {
      throw new Error(`Session ${sessionId} no longer has a live pending question.`);
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(this.directory, entry), "utf8")) as unknown;
        const session = parseSessionRecord(value);
        if (!session) continue;
        if (LIVE_STATUSES.has(session.status) && !this.ownerAlive(session)) {
          session.status = "interrupted";
          session.pendingAskId = undefined;
          session.error = "The MCP server stopped before this session reached a terminal state.";
          session.updatedAt = new Date().toISOString();
          this.persist(session);
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
  }

  private persist(session: SessionRecord): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${session.id}.json`);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
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

function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<SessionRecord>;
  if (
    typeof record.id !== "string" ||
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

function isSessionStatus(value: string): value is SessionStatus {
  return value === "running" || value === "waiting_for_input" || value === "completed" || value === "failed" || value === "interrupted";
}

function isSessionOwnerAlive(session: SessionRecord): boolean {
  if (!session.ownerPid) return false;
  try {
    process.kill(session.ownerPid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (!session.ownerStartToken) return true;
  const currentToken = processStartToken(session.ownerPid);
  return currentToken === undefined || currentToken === session.ownerStartToken;
}

function processStartToken(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}
