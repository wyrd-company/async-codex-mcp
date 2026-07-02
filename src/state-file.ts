import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionRecord } from "./session-store.js";

export type StateFileSession = {
  id: string;
  toolName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  pendingAsk?: string;
};

export type StateFile = {
  serverPid: number;
  claudePid: number;
  claudeSessionId?: string;
  updatedAt: string;
  sessions: StateFileSession[];
};

export function stateDir(): string {
  return process.env.ASYNC_CODEX_MCP_STATE_DIR ?? path.join(os.tmpdir(), "async-codex-mcp-state");
}

function stateFilePath(serverPid: number): string {
  return path.join(stateDir(), `${serverPid}.json`);
}

export function writeStateFile(sessions: Iterable<SessionRecord>): void {
  const snapshot: StateFile = {
    serverPid: process.pid,
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
        ? session.messages.find((message) => message.id === session.pendingAskId)?.message
        : undefined,
    })),
  };

  const file = stateFilePath(process.pid);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
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
      files.push(JSON.parse(fs.readFileSync(path.join(stateDir(), entry), "utf8")) as StateFile);
    } catch {
      // Partially written or corrupt snapshots are ignored.
    }
  }
  return files;
}
