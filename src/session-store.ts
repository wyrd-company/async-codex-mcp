import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type SessionStatus = "running" | "completed" | "failed";

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
};

export class SessionStore {
  readonly sessions = new Map<string, SessionRecord>();

  create(input: Pick<SessionRecord, "toolName" | "prompt" | "model" | "cwd">): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      ...input,
      id: crypto.randomUUID(),
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
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
    return session;
  }
}
