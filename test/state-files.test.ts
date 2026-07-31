import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/session-store.js";
import {
  readStateFiles,
  removeStateFile,
  writeStateFile,
} from "../src/state-file.js";
import {
  readWatcherFiles,
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
});
