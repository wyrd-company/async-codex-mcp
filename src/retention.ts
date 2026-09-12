// ---
// relationships:
//   references: session-store
// ---
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive, processStartToken } from "./process-liveness.js";

export type RetentionPolicy = {
  maxAgeDays: number;
  maxRecords: number;
  protectRecentDays: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxAgeDays: 365,
  maxRecords: 10_000,
  protectRecentDays: 90,
};

type RetentionRecord = {
  id: string;
  status:
    | "running"
    | "waiting_for_input"
    | "completed"
    | "failed"
    | "interrupted"
    | "stopped";
  updatedAt: string;
};

export type PruneSessionRecordsOptions = {
  directory: string;
  policy?: RetentionPolicy;
  now?: Date;
};

export type PruneSessionRecordsResult = {
  removedIds: string[];
  inspectedRecords: number;
};

const TERMINAL_STATUSES = new Set<RetentionRecord["status"]>([
  "completed",
  "failed",
  "interrupted",
  "stopped",
]);
const CLAIM_PREFIX = ".async-codex-retention-claim.";
const PROTECTION_PREFIX = ".async-codex-retention-protection.";
const LOCK_PREFIX = ".async-codex-record-lock.";
const PREPARED_LOCK_PREFIX = ".async-codex-record-lock-prepared.";
const LOCK_OWNER_PREFIX = "owner.";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export function pruneSessionRecords({
  directory,
  policy = DEFAULT_RETENTION_POLICY,
  now = new Date(),
}: PruneSessionRecordsOptions): PruneSessionRecordsResult {
  recoverRetentionArtifacts(directory);

  const records = readRetentionRecords(directory);
  const nowMs = now.getTime();
  const protectedCutoff =
    nowMs - policy.protectRecentDays * MILLISECONDS_PER_DAY;
  const ageCutoff = nowMs - policy.maxAgeDays * MILLISECONDS_PER_DAY;
  const protectedRecords = new Set(
    records
      .filter(({ record, updatedAtMs }) =>
        isProtected(record, updatedAtMs, policy, protectedCutoff),
      )
      .map(({ record }) => record.id),
  );
  const ageCandidates = new Set(
    policy.maxAgeDays === 0
      ? []
      : records
          .filter(
            ({ record, updatedAtMs }) =>
              TERMINAL_STATUSES.has(record.status) &&
              !protectedRecords.has(record.id) &&
              updatedAtMs < ageCutoff,
          )
          .map(({ record }) => record.id),
  );

  const countCandidates = new Set<string>();
  if (policy.maxRecords !== 0) {
    const retainedTerminal = records.filter(
      ({ record }) =>
        TERMINAL_STATUSES.has(record.status) && !ageCandidates.has(record.id),
    );
    let excess = Math.max(0, retainedTerminal.length - policy.maxRecords);
    for (const { record } of retainedTerminal
      .filter(({ record }) => !protectedRecords.has(record.id))
      .sort(compareRetentionRecords)) {
      if (excess === 0) break;
      countCandidates.add(record.id);
      excess -= 1;
    }
  }

  const removedIds: string[] = [];
  for (const candidate of records) {
    const selectedForAge = ageCandidates.has(candidate.record.id);
    const selectedForCount = countCandidates.has(candidate.record.id);
    if (!selectedForAge && !selectedForCount) continue;

    const result = withRecordFileLock(candidate.file, () =>
      removeFileAtomicallyIf(candidate.file, (contents) => {
        const current = parseRetentionRecord(contents, candidate.file);
        if (!current || !sameRecordVersion(current.record, candidate.record)) {
          return false;
        }
        if (
          isProtected(
            current.record,
            current.updatedAtMs,
            policy,
            protectedCutoff,
          )
        ) {
          return false;
        }
        return (
          TERMINAL_STATUSES.has(current.record.status) &&
          ((selectedForAge && current.updatedAtMs < ageCutoff) ||
            selectedForCount)
        );
      }),
    );
    if (result.acquired && result.value) removedIds.push(candidate.record.id);
  }

  return { removedIds, inspectedRecords: records.length };
}

/**
 * Renames a file to a private claim before evaluating it. A concurrent atomic
 * writer can recreate the original path without being removed. Rejected and
 * abandoned claims are restored without overwriting a newer file.
 */
export function removeFileAtomicallyIf(
  file: string,
  shouldRemove: (contents: string) => boolean,
): boolean {
  const claim = claimPath(file);
  try {
    fs.renameSync(file, claim);
  } catch {
    return false;
  }

  let remove = false;
  try {
    remove = shouldRemove(fs.readFileSync(claim, "utf8"));
  } catch {
    remove = false;
  }

  if (remove) {
    try {
      fs.rmSync(claim);
      return true;
    } catch {
      restoreClaim(claim, file);
      return false;
    }
  }

  restoreClaim(claim, file);
  return false;
}

export type ProtectedRecordResult<T> =
  { protected: true; value: T } | { protected: false };

/**
 * Keeps the inspected inode available while a caller reads and atomically
 * replaces the public record path. Cleanup can remove only its own link.
 */
export function withProtectedRecordFile<T>(
  file: string,
  operation: (protectedFile: string) => T,
): ProtectedRecordResult<T> {
  const directory = path.dirname(file);
  recoverRetentionArtifacts(directory);
  const protection = protectionPath(file);
  let linked = false;
  for (let attempt = 0; attempt < 2 && !linked; attempt += 1) {
    try {
      fs.linkSync(file, protection);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { protected: false };
      }
      recoverRetentionArtifacts(directory);
    }
  }
  if (!linked) return { protected: false };

  try {
    return { protected: true, value: operation(protection) };
  } finally {
    if (restoreMissingOriginal(protection, file)) {
      try {
        fs.rmSync(protection);
      } catch {
        // A later cleanup can reap the protection after this process exits.
      }
    }
  }
}

export type RecordFileLockResult<T> =
  { acquired: true; value: T } | { acquired: false };

/**
 * Runs one synchronous record operation under a cross-process, non-waiting
 * lock. A dead owner's lock is recovered from its PID and process start token.
 */
export function withRecordFileLock<T>(
  file: string,
  operation: () => T,
): RecordFileLockResult<T> {
  const lock = recordLockPath(file);
  recoverStaleRecordLock(lock);
  const ownerName = lockOwnerName();
  const prepared = path.join(
    path.dirname(file),
    `${PREPARED_LOCK_PREFIX}${crypto.randomUUID()}`,
  );
  try {
    fs.mkdirSync(prepared, { mode: 0o700 });
    fs.writeFileSync(path.join(prepared, ownerName), "", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(prepared, lock);
  } catch {
    removeOwnedLockDirectory(prepared, ownerName);
    return { acquired: false };
  }

  try {
    return { acquired: true, value: operation() };
  } finally {
    removeOwnedLockDirectory(lock, ownerName);
  }
}

export function recoverRetentionArtifacts(directory: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    const originalName = originalNameFromClaim(entry);
    if (originalName) {
      restoreClaim(
        path.join(directory, entry),
        path.join(directory, originalName),
      );
      continue;
    }

    const protection = protectionDetails(entry);
    if (protection) {
      const protectionFile = path.join(directory, entry);
      const originalAvailable = restoreMissingOriginal(
        protectionFile,
        path.join(directory, protection.originalName),
      );
      if (
        originalAvailable &&
        !isProcessAlive(protection.ownerPid, protection.ownerStartToken)
      ) {
        try {
          fs.rmSync(protectionFile);
        } catch {
          // Permission and concurrent cleanup failures are retried later.
        }
      }
      continue;
    }

    if (entry.startsWith(LOCK_PREFIX)) {
      recoverStaleRecordLock(path.join(directory, entry));
    } else if (entry.startsWith(PREPARED_LOCK_PREFIX)) {
      recoverStaleRecordLock(path.join(directory, entry));
    }
  }
}

function readRetentionRecords(directory: string): Array<{
  file: string;
  record: RetentionRecord;
  updatedAtMs: number;
}> {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    if (!entry.endsWith(".json")) return [];
    const file = path.join(directory, entry);
    try {
      const parsed = parseRetentionRecord(fs.readFileSync(file, "utf8"), file);
      return parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function parseRetentionRecord(
  contents: string,
  file: string,
):
  | {
      file: string;
      record: RetentionRecord;
      updatedAtMs: number;
    }
  | undefined {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<RetentionRecord>;
  if (
    typeof record.id !== "string" ||
    path.basename(file) !== `${record.id}.json` ||
    typeof record.status !== "string" ||
    !isRetentionStatus(record.status) ||
    typeof record.updatedAt !== "string"
  ) {
    return undefined;
  }
  const updatedAtMs = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return undefined;
  return { file, record: record as RetentionRecord, updatedAtMs };
}

function isRetentionStatus(value: string): value is RetentionRecord["status"] {
  return (
    value === "running" ||
    value === "waiting_for_input" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "stopped"
  );
}

function isProtected(
  record: RetentionRecord,
  updatedAtMs: number,
  policy: RetentionPolicy,
  protectedCutoff: number,
): boolean {
  return (
    record.status === "completed" &&
    policy.protectRecentDays > 0 &&
    updatedAtMs >= protectedCutoff
  );
}

function compareRetentionRecords(
  left: { record: RetentionRecord; updatedAtMs: number },
  right: { record: RetentionRecord; updatedAtMs: number },
): number {
  return (
    left.updatedAtMs - right.updatedAtMs ||
    left.record.id.localeCompare(right.record.id)
  );
}

function sameRecordVersion(
  current: RetentionRecord,
  inspected: RetentionRecord,
): boolean {
  return (
    current.id === inspected.id &&
    current.status === inspected.status &&
    current.updatedAt === inspected.updatedAt
  );
}

function claimPath(file: string): string {
  const encodedName = Buffer.from(path.basename(file)).toString("base64url");
  return path.join(
    path.dirname(file),
    `${CLAIM_PREFIX}${encodedName}.${crypto.randomUUID()}`,
  );
}

function originalNameFromClaim(entry: string): string | undefined {
  if (!entry.startsWith(CLAIM_PREFIX)) return undefined;
  const encodedName = entry.slice(CLAIM_PREFIX.length).split(".", 1)[0];
  if (!encodedName) return undefined;
  try {
    const originalName = Buffer.from(encodedName, "base64url").toString("utf8");
    return originalName && path.basename(originalName) === originalName
      ? originalName
      : undefined;
  } catch {
    return undefined;
  }
}

function protectionPath(file: string): string {
  const encodedName = Buffer.from(path.basename(file)).toString("base64url");
  const encodedStartToken = Buffer.from(
    processStartToken(process.pid) ?? "",
  ).toString("base64url");
  return path.join(
    path.dirname(file),
    `${PROTECTION_PREFIX}${encodedName}.${process.pid}.${encodedStartToken}.${crypto.randomUUID()}`,
  );
}

function recordLockPath(file: string): string {
  const encodedName = Buffer.from(path.basename(file)).toString("base64url");
  return path.join(path.dirname(file), `${LOCK_PREFIX}${encodedName}`);
}

function lockOwnerName(): string {
  const encodedStartToken = Buffer.from(
    processStartToken(process.pid) ?? "",
  ).toString("base64url");
  return `${LOCK_OWNER_PREFIX}${process.pid}.${encodedStartToken}.${crypto.randomUUID()}`;
}

function lockOwnerDetails(
  ownerName: string,
): { ownerPid: number; ownerStartToken?: string } | undefined {
  if (!ownerName.startsWith(LOCK_OWNER_PREFIX)) return undefined;
  const parts = ownerName.slice(LOCK_OWNER_PREFIX.length).split(".");
  if (parts.length !== 3) return undefined;
  const ownerPid = Number.parseInt(parts[0], 10);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return undefined;
  try {
    const ownerStartToken = Buffer.from(parts[1], "base64url").toString("utf8");
    return { ownerPid, ownerStartToken: ownerStartToken || undefined };
  } catch {
    return undefined;
  }
}

function recoverStaleRecordLock(lock: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(lock);
  } catch {
    return;
  }
  if (
    entries.length === 0 &&
    path.basename(lock).startsWith(PREPARED_LOCK_PREFIX)
  ) {
    try {
      fs.rmdirSync(lock);
    } catch {
      // A concurrent owner may have populated the prepared directory.
    }
    return;
  }
  if (entries.length !== 1) return;
  const owner = lockOwnerDetails(entries[0]);
  if (!owner || isProcessAlive(owner.ownerPid, owner.ownerStartToken)) return;
  removeOwnedLockDirectory(lock, entries[0]);
}

function removeOwnedLockDirectory(directory: string, ownerName: string): void {
  try {
    fs.rmSync(path.join(directory, ownerName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    fs.rmdirSync(directory);
  } catch {
    // A replacement owner keeps its nonempty directory.
  }
}

function protectionDetails(
  entry: string,
):
  | { originalName: string; ownerPid: number; ownerStartToken?: string }
  | undefined {
  if (!entry.startsWith(PROTECTION_PREFIX)) return undefined;
  const parts = entry.slice(PROTECTION_PREFIX.length).split(".");
  if (parts.length !== 4) return undefined;
  const [encodedName, pidText, encodedStartToken] = parts;
  const ownerPid = Number.parseInt(pidText, 10);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return undefined;
  try {
    const originalName = Buffer.from(encodedName, "base64url").toString("utf8");
    if (!originalName || path.basename(originalName) !== originalName) {
      return undefined;
    }
    const ownerStartToken = Buffer.from(
      encodedStartToken,
      "base64url",
    ).toString("utf8");
    return {
      originalName,
      ownerPid,
      ownerStartToken: ownerStartToken || undefined,
    };
  } catch {
    return undefined;
  }
}

function restoreClaim(claim: string, original: string): void {
  if (!restoreMissingOriginal(claim, original)) return;
  try {
    fs.rmSync(claim);
  } catch {
    // A later cleanup can recover an abandoned claim.
  }
}

function restoreMissingOriginal(source: string, original: string): boolean {
  try {
    fs.linkSync(source, original);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST";
  }
}
