import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processStartToken } from "./process-liveness.js";
import type { SessionRecord } from "./session-store.js";

export type StateFileSession = {
  id: string;
  toolName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  pendingAsk?: string;
  notifications: StateFileNotification[];
};

export type StateFileNotification = {
  id: string;
  message: string;
  topic?: string;
  createdAt: string;
};

export type StateFile = {
  serverPid: number;
  serverStartToken?: string;
  claudePid: number;
  claudeSessionId?: string;
  updatedAt: string;
  sessions: StateFileSession[];
};

export function stateDir(): string {
  return (
    process.env.ASYNC_CODEX_MCP_STATE_DIR ??
    path.join(os.tmpdir(), "async-codex-mcp-state")
  );
}

function stateFilePath(serverPid: number): string {
  return path.join(stateDir(), `${serverPid}.json`);
}

export function writeStateFile(sessions: Iterable<SessionRecord>): void {
  const snapshot: StateFile = {
    serverPid: process.pid,
    serverStartToken: processStartToken(process.pid),
    claudePid: process.ppid,
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID,
    updatedAt: new Date().toISOString(),
    sessions: [...sessions].map((session) => ({
      id: session.id,
      toolName: session.toolName,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      pendingAsk: session.pendingAskId
        ? session.messages.find(
            (message) => message.id === session.pendingAskId,
          )?.message
        : undefined,
      notifications: session.messages
        .filter((message) => message.type === "notify")
        .map(({ id, message, topic, createdAt }) => ({
          id,
          message,
          topic,
          createdAt,
        })),
    })),
  };

  const file = stateFilePath(process.pid);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeStateFile(): void {
  fs.rmSync(stateFilePath(process.pid), { force: true });
}

export function readStateFiles(): StateFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir());
  } catch {
    return [];
  }

  const files: StateFile[] = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    try {
      const parsed = parseStateFile(
        JSON.parse(fs.readFileSync(path.join(stateDir(), entry), "utf8")),
      );
      if (parsed) files.push(parsed);
    } catch {
      // Partially written or corrupt snapshots are ignored.
    }
  }
  return files;
}

function parseStateFile(value: unknown): StateFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const file = value as Partial<StateFile>;
  if (
    typeof file.serverPid !== "number" ||
    typeof file.claudePid !== "number" ||
    typeof file.updatedAt !== "string" ||
    !Array.isArray(file.sessions)
  ) {
    return undefined;
  }
  const sessions = file.sessions.filter(
    (session): session is StateFileSession =>
      Boolean(
        session &&
        typeof session.id === "string" &&
        typeof session.toolName === "string" &&
        typeof session.status === "string" &&
        typeof session.createdAt === "string" &&
        typeof session.updatedAt === "string",
      ),
  );
  return {
    serverPid: file.serverPid,
    serverStartToken:
      typeof file.serverStartToken === "string"
        ? file.serverStartToken
        : undefined,
    claudePid: file.claudePid,
    claudeSessionId:
      typeof file.claudeSessionId === "string"
        ? file.claudeSessionId
        : undefined,
    updatedAt: file.updatedAt,
    sessions: sessions.map((session) => ({
      ...session,
      notifications: Array.isArray(session.notifications)
        ? session.notifications
        : [],
    })),
  };
}
