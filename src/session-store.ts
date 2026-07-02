import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type SessionStatus = "running" | "waiting_for_input" | "completed" | "failed";

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
};

export class SessionStore {
  readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingAskResolvers = new Map<string, (response: string) => void>();

  // Invoked after every mutation; the server uses this to persist a
  // snapshot that the plugin's Stop hook reads out-of-process.
  onChange?: (store: SessionStore) => void;

  create(input: Pick<SessionRecord, "toolName" | "prompt" | "model" | "cwd">): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      ...input,
      id: crypto.randomUUID(),
      status: "running",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(session.id, session);
    this.onChange?.(this);
    return session;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  update(id: string, patch: Partial<Omit<SessionRecord, "id" | "createdAt">>): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.onChange?.(this);
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
    this.onChange?.(this);
    return message;
  }

  ask(sessionId: string, input: { message: string; context?: string }): { message: SessionMessage; response: Promise<string> } {
    const session = this.require(sessionId);
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

    const response = new Promise<string>((resolve) => {
      this.pendingAskResolvers.set(message.id, resolve);
    });
    this.onChange?.(this);
    return { message, response };
  }

  answer(sessionId: string, response: string): SessionMessage {
    const session = this.require(sessionId);
    if (!session.pendingAskId) {
      throw new Error(`Session ${sessionId} is not waiting for input.`);
    }

    const message = session.messages.find((item) => item.id === session.pendingAskId);
    if (!message) {
      throw new Error(`Session ${sessionId} pending question was not found.`);
    }

    const now = new Date().toISOString();
    message.response = response;
    message.answeredAt = now;
    session.pendingAskId = undefined;
    session.status = "running";
    session.updatedAt = now;

    const resolve = this.pendingAskResolvers.get(message.id);
    this.pendingAskResolvers.delete(message.id);
    resolve?.(response);
    this.onChange?.(this);
    return message;
  }

  private require(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }
}
