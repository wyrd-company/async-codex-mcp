import fs from "node:fs";
import path from "node:path";
import { isProcessAlive, processStartToken } from "./process-liveness.js";
import {
  recoverRetentionArtifacts,
  removeFileAtomicallyIf,
} from "./retention.js";
import { stateDir } from "./state-file.js";

export type WatcherFile = {
  watcherPid: number;
  watcherStartToken?: string;
  claudeSessionId?: string;
  ancestorPids: number[];
  startedAt: string;
  coverage: WatcherCoverage;
};

export type WatcherCoverage =
  { scope: "conversation" } | { scope: "session"; sessionId: string };

function watcherDir(): string {
  return path.join(stateDir(), "watchers");
}

function watcherFilePath(pid: number): string {
  return path.join(watcherDir(), `${pid}.json`);
}

export function writeWatcherFile(
  ancestors: Set<number>,
  coverage: WatcherCoverage,
): void {
  reapStaleWatcherFiles();
  const snapshot: WatcherFile = {
    watcherPid: process.pid,
    watcherStartToken: processStartToken(process.pid),
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID,
    ancestorPids: [...ancestors],
    startedAt: new Date().toISOString(),
    coverage,
  };

  const file = watcherFilePath(process.pid);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(watcherDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeWatcherFile(): void {
  fs.rmSync(watcherFilePath(process.pid), { force: true });
}

export function readWatcherFiles(): WatcherFile[] {
  reapStaleWatcherFiles();
  return readCurrentWatcherFiles();
}

export function reapStaleWatcherFiles(
  ownerAlive: (pid: number, startToken?: string) => boolean = isProcessAlive,
): number {
  recoverRetentionArtifacts(watcherDir());
  let entries: string[];
  try {
    entries = fs.readdirSync(watcherDir());
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    const file = path.join(watcherDir(), entry);
    try {
      const parsed = parseWatcherFile(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
      if (!parsed || parsed.watcherPid !== Number.parseInt(entry, 10)) continue;
      if (ownerAlive(parsed.watcherPid, parsed.watcherStartToken)) continue;
      if (
        removeFileAtomicallyIf(file, (contents) => {
          const current = parseWatcherFile(JSON.parse(contents));
          return Boolean(
            current &&
            current.watcherPid === parsed.watcherPid &&
            current.watcherStartToken === parsed.watcherStartToken &&
            !ownerAlive(current.watcherPid, current.watcherStartToken),
          );
        })
      ) {
        removed += 1;
      }
    } catch {
      // Partially written or corrupt snapshots are ignored.
    }
  }
  return removed;
}

function readCurrentWatcherFiles(): WatcherFile[] {
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
      const parsed = parseWatcherFile(
        JSON.parse(fs.readFileSync(path.join(watcherDir(), entry), "utf8")),
      );
      if (parsed) files.push(parsed);
    } catch {
      // Partially written or corrupt snapshots are ignored.
    }
  }
  return files;
}

function parseWatcherFile(value: unknown): WatcherFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const watcher = value as Partial<WatcherFile>;
  const coverage = watcher.coverage;
  if (
    typeof watcher.watcherPid !== "number" ||
    !Array.isArray(watcher.ancestorPids) ||
    !watcher.ancestorPids.every((pid) => typeof pid === "number") ||
    typeof watcher.startedAt !== "string" ||
    !coverage ||
    (coverage.scope !== "conversation" &&
      (coverage.scope !== "session" ||
        typeof coverage.sessionId !== "string" ||
        !coverage.sessionId))
  ) {
    return undefined;
  }
  return {
    watcherPid: watcher.watcherPid,
    watcherStartToken:
      typeof watcher.watcherStartToken === "string"
        ? watcher.watcherStartToken
        : undefined,
    claudeSessionId:
      typeof watcher.claudeSessionId === "string"
        ? watcher.claudeSessionId
        : undefined,
    ancestorPids: watcher.ancestorPids,
    startedAt: watcher.startedAt,
    coverage,
  };
}
