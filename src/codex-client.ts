// ---
// relationships:
//   references: config
// ---
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import WebSocket from "ws";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AsyncCodexConfig, ToolProfile } from "./config.js";

export type CodexToolArguments = {
  prompt: string;
  model?: string;
  cwd?: string;
};
export type CodexClientLike = {
  callCodex(
    profile: ToolProfile,
    args: CodexToolArguments,
  ): Promise<CallToolResult>;
  continueSession(
    sessionId: string,
    prompt: string,
    cwd?: string,
    profile?: ToolProfile,
  ): Promise<CallToolResult>;
  /** Stop all work owned by this client. Server rounds use separate clients. */
  stop?(): Promise<void>;
  close(): Promise<void>;
};

type Pending = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type Turn = {
  buffered: any[];
  id?: string;
  expired?: boolean;
  interruptRequested?: boolean;
  resolve(value: CallToolResult): void;
  reject(error: Error): void;
  messages: Map<string, string>;
  timer: NodeJS.Timeout;
};

class AppServerRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(`Codex app-server: ${message}`);
  }
}

/** Connects to an existing Codex app-server; never owns the server process. */
export class CodexAppServerClient implements CodexClientLike {
  private connection?: Promise<AppServerConnection>;
  private current?: AppServerConnection;
  private closed = false;
  private readonly connections = new Set<AppServerConnection>();

  constructor(private readonly config: AsyncCodexConfig) {}

  async callCodex(
    profile: ToolProfile,
    args: CodexToolArguments,
  ): Promise<CallToolResult> {
    const connection = await this.getConnection();
    const result = await connection.request("thread/start", {
      model: args.model ?? profile.model,
      cwd: args.cwd ?? this.config.codex.cwd ?? process.cwd(),
      sandbox: profile.sandboxMode,
      approvalPolicy: profile.approvalPolicy,
      baseInstructions: profile.baseInstructions,
      developerInstructions: profile.developerInstructions,
      config: {
        ...profile.config,
        ...(profile.compactPrompt
          ? { compact_prompt: profile.compactPrompt }
          : {}),
      },
    });
    if (typeof result?.thread?.id !== "string")
      throw new Error(
        "Codex app-server thread/start did not return a thread id.",
      );
    return connection.runTurn(result.thread.id, args.prompt);
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    cwd?: string,
    profile?: ToolProfile,
  ): Promise<CallToolResult> {
    const connection = await this.getConnection();
    const result = await connection.request("thread/fork", {
      threadId: sessionId,
      cwd: cwd ?? this.config.codex.cwd ?? process.cwd(),
      ...(profile
        ? {
            model: profile.model,
            sandbox: profile.sandboxMode,
            approvalPolicy: profile.approvalPolicy,
            baseInstructions: profile.baseInstructions,
            developerInstructions: profile.developerInstructions,
            config: {
              ...profile.config,
              ...(profile.compactPrompt
                ? { compact_prompt: profile.compactPrompt }
                : {}),
            },
          }
        : {}),
    });
    if (typeof result?.thread?.id !== "string")
      throw new Error(
        "Codex app-server thread/fork did not return a thread id.",
      );
    return connection.runTurn(result.thread.id, prompt, cwd);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.connections].map((connection) => connection.close()),
    );
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.connections].map((connection) => connection.stop()),
    );
  }

  private getConnection(): Promise<AppServerConnection> {
    if (this.closed)
      return Promise.reject(new Error("Codex app-server client is closed."));
    if (!this.connection) {
      const connection = new AppServerConnection(this.config, () => {
        if (this.current === connection) {
          this.connection = undefined;
          this.current = undefined;
        }
      });
      this.connections.add(connection);
      void connection
        .whenExited()
        .then(() => this.connections.delete(connection));
      this.current = connection;
      this.connection = connection
        .initialize()
        .then(() => connection)
        .catch(async (error) => {
          await connection.close();
          throw error;
        });
    }
    return this.connection;
  }
}

// Retain the exported class name for existing integrations.
export { CodexAppServerClient as CodexMcpClient };

class AppServerConnection {
  private readonly socket: WebSocket;
  private closing = false;
  private readonly starts = new Set<Promise<any>>();
  private readonly interrupts = new Set<Promise<void>>();
  private stopPromise?: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private readonly turns = new Map<string, Turn>();
  private nextId = 0;
  private failure?: Error;
  private readonly exited: Promise<void>;
  private hasExited = false;

  constructor(
    private readonly config: AsyncCodexConfig,
    private readonly disconnected: () => void,
  ) {
    const endpoint = appServerEndpoint(config);
    this.socket = endpoint.startsWith("unix://")
      ? new WebSocket("ws://localhost", {
          createConnection: () => net.createConnection(endpoint.slice(7)),
        })
      : new WebSocket(endpoint);
    this.exited = new Promise((resolve) =>
      this.socket.once("close", () => {
        this.hasExited = true;
        resolve();
      }),
    );
    this.socket.on("error", (error) =>
      this.fail(
        new Error(
          `Cannot connect to existing Codex app-server at ${endpoint}: ${error.message}. Start the Codex service or configure codex.endpoint.`,
        ),
      ),
    );
    this.socket.on("close", () =>
      this.fail(new Error("Codex app-server connection closed.")),
    );
    this.socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Unexpected binary message");
        this.receive(JSON.parse(data.toString()));
      } catch {
        this.fail(
          new Error("Codex app-server emitted an invalid JSON message."),
        );
        this.socket.terminate();
      }
    });
  }

  async initialize(): Promise<void> {
    try {
      await this.request(
        "initialize",
        { clientInfo: { name: "async_codex_mcp", version: "0.7.1" } },
        DEFAULT_REQUEST_TIMEOUT_MSEC,
      );
      this.send({ method: "initialized", params: {} });
    } catch (error) {
      throw new Error(
        `Codex app-server initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.config.codex.requestTimeoutSec * 1000,
  ): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex app-server ${method} exceeded its ${timeoutMs / 1000}s wait limit.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  runTurn(
    threadId: string,
    prompt: string,
    cwd?: string,
  ): Promise<CallToolResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing)
      return Promise.reject(new Error("Codex app-server connection closed."));
    if (this.turns.has(threadId))
      return Promise.reject(
        new Error(`Codex thread ${threadId} already has an active turn.`),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(threadId);
        activeTurn.expired = true;
        this.interrupt(threadId, activeTurn);
        reject(
          new Error("Codex app-server turn exceeded codex.requestTimeoutSec."),
        );
      }, this.config.codex.requestTimeoutSec * 1000);
      // Subscribe before turn/start: completion may arrive before its response.
      const activeTurn: Turn = {
        buffered: [],
        resolve,
        reject,
        timer,
        messages: new Map<string, string>(),
      };
      this.turns.set(threadId, activeTurn);
      const start = this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd,
      });
      this.starts.add(start);
      void start
        .then((result) => {
          if (typeof result?.turn?.id !== "string")
            throw new Error(
              "Codex app-server turn/start did not return a turn id.",
            );
          activeTurn.id = result.turn.id;
          if (activeTurn.expired) this.interrupt(threadId, activeTurn);
          else for (const message of activeTurn.buffered) this.receive(message);
          activeTurn.buffered = [];
        })
        .catch((error) => {
          const turn = this.turns.get(threadId);
          if (turn === activeTurn) {
            clearTimeout(turn.timer);
            this.turns.delete(threadId);
            turn.reject(error);
          }
        })
        .finally(() => this.starts.delete(start));
    });
  }

  private interrupt(threadId: string, turn: Turn): void {
    if (turn.id && !turn.interruptRequested) {
      turn.interruptRequested = true;
      const request = this.request("turn/interrupt", {
        threadId,
        turnId: turn.id,
      })
        .then(() => {})
        .catch(async (error) => {
          // Native Codex rejects interruption if completion won the race. Recover
          // the exact terminal turn before closing, even if its notification lags.
          if (
            !(error instanceof AppServerRpcError) ||
            error.code !== -32600 ||
            error.message !== "Codex app-server: no active turn to interrupt"
          )
            throw error;
          if (!this.turns.has(threadId)) return;
          const result = await this.request("thread/read", {
            threadId,
            includeTurns: true,
          });
          const completed =
            result?.thread?.id === threadId
              ? result.thread.turns?.find(
                  (candidate: any) =>
                    candidate.id === turn.id &&
                    ["completed", "failed", "interrupted"].includes(
                      candidate.status,
                    ),
                )
              : undefined;
          if (!completed) throw error;
          this.receive({
            method: "turn/completed",
            params: { threadId, turn: completed },
          });
        });
      this.interrupts.add(request);
      void request
        .catch(() => {})
        .finally(() => this.interrupts.delete(request));
    }
  }

  private receive(message: any): void {
    if (message.method && message.id !== undefined) {
      // Interactive input uses the existing callback MCP tools. Never leave an
      // unsupported server request pending or silently approve an operation.
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported app-server client request: ${message.method}. Use the async callback tools for user input.`,
        },
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new AppServerRpcError(message.error.code, message.error.message),
        );
      else pending.resolve(message.result);
      return;
    }
    const params = message.params;
    const turn = this.turns.get(params?.threadId);
    if (!turn) return;
    if (!turn.id) {
      turn.buffered.push(message);
      return;
    }
    const turnId = params.turnId ?? params.turn?.id;
    if (turnId !== turn.id) return;
    turn.timer.refresh();
    if (
      message.method === "item/completed" &&
      params.item?.type === "agentMessage"
    ) {
      turn.messages.set(params.item.id, params.item.text);
    }
    if (message.method === "turn/completed") {
      clearTimeout(turn.timer);
      this.turns.delete(params.threadId);
      const completed = params.turn;
      if (completed?.status !== "completed") {
        turn.reject(
          new Error(
            `Codex turn ${completed?.status ?? "unknown"}: ${completed?.error?.message ?? "Turn did not complete."}`,
          ),
        );
        return;
      }
      for (const item of completed.items ?? []) {
        if (item.type === "agentMessage") turn.messages.set(item.id, item.text);
      }
      turn.resolve({
        content: [...turn.messages.values()].map((text) => ({
          type: "text",
          text,
        })),
        _meta: { threadId: params.threadId },
      });
    }
  }

  private send(message: unknown): void {
    const send = () => {
      if (!this.failure)
        this.socket.send(JSON.stringify(message), (error) => {
          if (error)
            this.fail(
              new Error(`Codex app-server send failed: ${error.message}`),
            );
        });
    };
    if (this.socket.readyState === WebSocket.CONNECTING)
      this.socket.once("open", send);
    else send();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.pending.clear();
    this.turns.clear();
    this.disconnected();
  }

  whenExited(): Promise<void> {
    return this.exited;
  }

  async close(): Promise<void> {
    // Cleanup is best effort; explicit stop reports an interruption failure.
    await this.stop().catch(() => {});
  }

  stop(): Promise<void> {
    this.closing = true;
    return (this.stopPromise ??= this.stopOwnedTurns());
  }

  private async stopOwnedTurns(): Promise<void> {
    try {
      // A start may have reached the server before its turn ID is acknowledged.
      // Keep the socket open until we can interrupt precisely that owned turn.
      const starts = await Promise.allSettled([...this.starts]);
      const rejectedStart = starts.find(
        (result) => result.status === "rejected",
      );
      if (rejectedStart?.status === "rejected") throw rejectedStart.reason;
      for (const [threadId, turn] of this.turns) this.interrupt(threadId, turn);
      await Promise.all([...this.interrupts]);
    } finally {
      this.fail(new Error("Codex app-server connection closed."));
      if (!this.hasExited) this.socket.terminate();
      await this.exited;
    }
  }
}

/** Mirrors Codex's per-user control socket discovery without launching a CLI. */
export function appServerEndpoint(config: AsyncCodexConfig): string {
  const env = { ...process.env, ...config.codex.env };
  const explicit = config.codex.endpoint ?? env.CODEX_APP_SERVER_URL;
  if (explicit) return explicit;
  const home = path.resolve(
    config.codex.cwd ?? process.cwd(),
    env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"),
  );
  // The TUI discovers the canonical CODEX_HOME, including symlinked profiles.
  let canonicalHome = home;
  try {
    canonicalHome = fs.realpathSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return `unix://${path.join(canonicalHome, "app-server-control", "app-server-control.sock")}`;
}
