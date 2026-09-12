// ---
// relationships:
//   verifies: retention
// ---
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  pruneSessionRecords,
  removeFileAtomicallyIf,
  withProtectedRecordFile,
  withRecordFileLock,
  type RetentionPolicy,
} from "../src/retention.js";

describe("session retention", () => {
  let directory: string;
  const now = new Date("2026-01-01T00:00:00.000Z");

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "record-retention-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("materializes conservative defaults while keeping direct config objects compatible", () => {
    expect(loadConfig().retention).toEqual({
      maxAgeDays: 365,
      maxRecords: 10_000,
      protectRecentDays: 90,
    });
  });

  it("loads explicit retention limits including unlimited values", () => {
    const configFile = path.join(directory, "config.yaml");
    fs.writeFileSync(
      configFile,
      [
        "retention:",
        "  maxAgeDays: 0",
        "  maxRecords: 250",
        "  protectRecentDays: 0",
      ].join("\n"),
    );

    expect(loadConfig(configFile).retention).toEqual({
      maxAgeDays: 0,
      maxRecords: 250,
      protectRecentDays: 0,
    });
  });

  it("rejects negative retention limits", () => {
    const configFile = path.join(directory, "config.yaml");
    fs.writeFileSync(configFile, "retention:\n  maxAgeDays: -1\n");

    expect(() => loadConfig(configFile)).toThrow();
  });

  it("expires old terminal records and supports stopped sessions", () => {
    writeRecord("completed-old", "completed", daysAgo(400));
    writeRecord("failed-old", "failed", daysAgo(401));
    writeRecord("interrupted-old", "interrupted", daysAgo(402));
    writeRecord("stopped-old", "stopped", daysAgo(403));
    writeRecord("running-old", "running", daysAgo(800));
    writeRecord("waiting-old", "waiting_for_input", daysAgo(800));
    writeRecord("completed-recent", "completed", daysAgo(10));

    const result = pruneSessionRecords({ directory, now });

    expect(result.removedIds.sort()).toEqual([
      "completed-old",
      "failed-old",
      "interrupted-old",
      "stopped-old",
    ]);
    expect(recordNames()).toEqual([
      "completed-recent",
      "running-old",
      "waiting-old",
    ]);
  });

  it("applies the count cap deterministically without pruning protected completed records", () => {
    writeRecord("alpha", "failed", daysAgo(50));
    writeRecord("beta", "interrupted", daysAgo(50));
    writeRecord("gamma", "stopped", daysAgo(40));
    writeRecord("recent", "completed", daysAgo(2));
    writeRecord("active", "running", daysAgo(500));

    const result = pruneSessionRecords({
      directory,
      now,
      policy: policy({ maxRecords: 2 }),
    });

    expect(result.removedIds).toEqual(["alpha", "beta"]);
    expect(recordNames()).toEqual(["active", "gamma", "recent"]);
  });

  it("allows protected completed records to exceed the count cap", () => {
    writeRecord("recent-alpha", "completed", daysAgo(1));
    writeRecord("recent-beta", "completed", daysAgo(2));
    writeRecord("unprotected", "failed", daysAgo(3));

    const result = pruneSessionRecords({
      directory,
      now,
      policy: policy({ maxRecords: 1 }),
    });

    expect(result.removedIds).toEqual(["unprotected"]);
    expect(recordNames()).toEqual(["recent-alpha", "recent-beta"]);
  });

  it("allows unlimited age and count retention", () => {
    writeRecord("old", "failed", daysAgo(2_000));
    writeRecord("older", "stopped", daysAgo(3_000));

    const result = pruneSessionRecords({
      directory,
      now,
      policy: policy({ maxAgeDays: 0, maxRecords: 0 }),
    });

    expect(result.removedIds).toEqual([]);
    expect(recordNames()).toEqual(["old", "older"]);
  });

  it("ignores malformed and mismatched records", () => {
    fs.writeFileSync(path.join(directory, "malformed.json"), "{");
    fs.writeFileSync(
      path.join(directory, "wrong-name.json"),
      JSON.stringify({
        id: "different-name",
        status: "failed",
        updatedAt: daysAgo(800),
      }),
    );

    expect(pruneSessionRecords({ directory, now }).removedIds).toEqual([]);
    expect(fs.existsSync(path.join(directory, "malformed.json"))).toBe(true);
    expect(fs.existsSync(path.join(directory, "wrong-name.json"))).toBe(true);
  });

  it("does not remove a concurrent replacement after claiming the inspected file", () => {
    const file = writeRecord("sample", "failed", daysAgo(800));

    const removed = removeFileAtomicallyIf(file, () => {
      fs.writeFileSync(file, "replacement", { mode: 0o600 });
      return true;
    });

    expect(removed).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("replacement");
  });

  it("keeps a stable record inode through a concurrent prune claim", () => {
    const file = writeRecord("sample", "completed", daysAgo(800));

    const protectedResult = withProtectedRecordFile(file, (protectedFile) => {
      expect(removeFileAtomicallyIf(file, () => true)).toBe(true);
      const record = JSON.parse(fs.readFileSync(protectedFile, "utf8"));
      record.status = "running";
      record.updatedAt = now.toISOString();
      fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
      return record.status;
    });

    expect(protectedResult).toEqual({ protected: true, value: "running" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).status).toBe("running");
  });

  it("restores the public record when a protected operation loses contention", () => {
    const file = writeRecord("sample", "completed", daysAgo(800));

    const result = withProtectedRecordFile(file, () => {
      expect(removeFileAtomicallyIf(file, () => true)).toBe(true);
      return "retry";
    });

    expect(result).toEqual({ protected: true, value: "retry" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      id: "sample",
      status: "completed",
    });
  });

  it("rejects a concurrent record operation while its owner holds the lock", () => {
    const file = writeRecord("sample", "completed", daysAgo(1));

    const outer = withRecordFileLock(file, () =>
      withRecordFileLock(file, () => "unexpected"),
    );

    expect(outer).toEqual({ acquired: true, value: { acquired: false } });
    expect(withRecordFileLock(file, () => "next")).toEqual({
      acquired: true,
      value: "next",
    });
  });

  it.each([
    [2_147_483_647, ""],
    [process.pid, "reused-process-start"],
  ])("recovers a stale record lock for owner %s", (pid, startToken) => {
    const file = writeRecord("sample", "completed", daysAgo(1));
    const encodedName = Buffer.from(path.basename(file)).toString("base64url");
    const lock = path.join(
      directory,
      `.async-codex-record-lock.${encodedName}`,
    );
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(
      path.join(
        lock,
        `owner.${pid}.${Buffer.from(startToken).toString("base64url")}.00000000-0000-0000-0000-000000000000`,
      ),
      "",
      { mode: 0o600 },
    );

    expect(withRecordFileLock(file, () => "recovered")).toEqual({
      acquired: true,
      value: "recovered",
    });
    expect(fs.existsSync(lock)).toBe(false);
  });

  function writeRecord(id: string, status: string, updatedAt: string): string {
    const file = path.join(directory, `${id}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ id, status, updatedAt, createdAt: updatedAt }),
      { mode: 0o600 },
    );
    return file;
  }

  function recordNames(): string[] {
    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5))
      .sort();
  }

  function daysAgo(days: number): string {
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
  }

  function policy(overrides: Partial<RetentionPolicy>): RetentionPolicy {
    return {
      maxAgeDays: 365,
      maxRecords: 10_000,
      protectRecentDays: 90,
      ...overrides,
    };
  }
});
