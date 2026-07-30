import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state-file.js";

export type WatcherFile = {
  watcherPid: number;
  claudeSessionId?: string;
  ancestorPids: number[];
  startedAt: string;
};

function watcherDir(): string {
  return path.join(stateDir(), "watchers");
}

function watcherFilePath(pid: number): string {
  return path.join(watcherDir(), `${pid}.json`);
}

export function writeWatcherFile(ancestors: Set<number>): void {
  const snapshot: WatcherFile = {
    watcherPid: process.pid,
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID,
    ancestorPids: [...ancestors],
    startedAt: new Date().toISOString(),
  };

  const file = watcherFilePath(process.pid);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(watcherDir(), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, file);
}

export function removeWatcherFile(): void {
  fs.rmSync(watcherFilePath(process.pid), { force: true });
}

export function readWatcherFiles(): WatcherFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(watcherDir());
  } catch {
    return [];
  }

  const files: WatcherFile[] = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    try {
      files.push(JSON.parse(fs.readFileSync(path.join(watcherDir(), entry), "utf8")) as WatcherFile);
    } catch {
      // Partially written or corrupt snapshots are ignored.
    }
  }
  return files;
}
