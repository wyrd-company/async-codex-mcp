import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/session-store.js";
import {
  readStateFiles,
  reapStaleStateFiles,
  removeStateFile,
  writeStateFile,
} from "../src/state-file.js";
import {
  readWatcherFiles,
  reapStaleWatcherFiles,
  removeWatcherFile,
  writeWatcherFile,
} from "../src/watcher-file.js";

describe("live state projections", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "async-codex-live-state-"),
    );
    process.env.ASYNC_CODEX_MCP_STATE_DIR = directory;
  });

  afterEach(() => {
    removeStateFile();
    removeWatcherFile();
    delete process.env.ASYNC_CODEX_MCP_STATE_DIR;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips exact session watcher coverage and process identity", () => {
    writeWatcherFile(new Set([101, 202]), {
      scope: "session",
      sessionId: "session-alpha",
    });

    expect(readWatcherFiles()).toEqual([
      expect.objectContaining({
        watcherPid: process.pid,
        watcherStartToken: expect.any(String),
        ancestorPids: [101, 202],
        coverage: { scope: "session", sessionId: "session-alpha" },
      }),
    ]);
  });

  it("projects notify fields without callback secrets, results, or responses", () => {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: "session-alpha",
      toolName: "codex",
      prompt: "perform a generic task",
      status: "running",
      createdAt: now,
      updatedAt: now,
      result: { content: [{ type: "text", text: "private result" }] },
      messages: [
        {
          id: "notification-alpha",
          type: "notify",
          message: "progress",
          topic: "status",
          response: "private response",
          createdAt: now,
        },
      ],
    };

    writeStateFile([session]);

    const raw = fs.readFileSync(
      path.join(directory, `${process.pid}.json`),
      "utf8",
    );
    expect(raw).not.toContain("private result");
    expect(raw).not.toContain("private response");
    expect(raw).not.toContain("token");
    expect(readStateFiles()[0]).toEqual(
      expect.objectContaining({
        serverStartToken: expect.any(String),
        sessions: [
          expect.objectContaining({
            id: "session-alpha",
            notifications: [
              expect.objectContaining({
                id: "notification-alpha",
                message: "progress",
                topic: "status",
              }),
            ],
          }),
        ],
      }),
    );
  });

  it("reaps dead and PID-reused server snapshots but preserves live owners", () => {
    writeServerSnapshot(101, "old");
    writeServerSnapshot(202, "current");
    writeServerSnapshot(303, "current");

    const removed = reapStaleStateFiles(
      (pid, token) => pid === 202 && token === "current",
    );

    expect(removed).toBe(2);
    expect(
      fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")),
    ).toEqual(["202.json"]);
  });

  it("reaps dead and PID-reused watcher snapshots but preserves live owners", () => {
    const watchers = path.join(directory, "watchers");
    fs.mkdirSync(watchers);
    writeWatcherSnapshot(watchers, 101, "old");
    writeWatcherSnapshot(watchers, 202, "current");
    writeWatcherSnapshot(watchers, 303, "current");

    const removed = reapStaleWatcherFiles(
      (pid, token) => pid === 202 && token === "current",
    );

    expect(removed).toBe(2);
    expect(
      fs.readdirSync(watchers).filter((entry) => entry.endsWith(".json")),
    ).toEqual(["202.json"]);
  });

  it("leaves malformed temporary snapshots untouched", () => {
    fs.writeFileSync(path.join(directory, "101.json"), "{");
    fs.mkdirSync(path.join(directory, "watchers"));
    fs.writeFileSync(path.join(directory, "watchers", "202.json"), "{");

    expect(reapStaleStateFiles(() => false)).toBe(0);
    expect(reapStaleWatcherFiles(() => false)).toBe(0);
    expect(fs.existsSync(path.join(directory, "101.json"))).toBe(true);
    expect(fs.existsSync(path.join(directory, "watchers", "202.json"))).toBe(
      true,
    );
  });

  function writeServerSnapshot(pid: number, startToken: string): void {
    fs.writeFileSync(
      path.join(directory, `${pid}.json`),
      JSON.stringify({
        serverPid: pid,
        serverStartToken: startToken,
        claudePid: 1,
        updatedAt: new Date().toISOString(),
        sessions: [],
      }),
      { mode: 0o600 },
    );
  }

  function writeWatcherSnapshot(
    watchers: string,
    pid: number,
    startToken: string,
  ): void {
    fs.writeFileSync(
      path.join(watchers, `${pid}.json`),
      JSON.stringify({
        watcherPid: pid,
        watcherStartToken: startToken,
        ancestorPids: [],
        startedAt: new Date().toISOString(),
        coverage: { scope: "conversation" },
      }),
      { mode: 0o600 },
    );
  }
});
