// ---
// relationships:
//   references: config
// ---
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { createInterface } from "node:readline";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AsyncCodexConfig, ToolProfile } from "./config.js";

export type CodexToolArguments = { prompt: string; model?: string; cwd?: string };
export type CodexClientLike = {
  callCodex(profile: ToolProfile, args: CodexToolArguments): Promise<CallToolResult>;
  continueSession(sessionId: string, prompt: string, cwd?: string, profile?: ToolProfile): Promise<CallToolResult>;
  /** Stop all work owned by this client. Server rounds use separate clients. */
  stop?(): Promise<void>;
  close(): Promise<void>;
};

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Turn = { id?: string; expired?: boolean; interruptRequested?: boolean; resolve(value: CallToolResult): void; reject(error: Error): void; messages: Map<string, string>; timer: NodeJS.Timeout };

/** Adapts Codex's app-server JSONL API to the wrapper's durable result contract. */
export class CodexAppServerClient implements CodexClientLike {
  private connection?: Promise<AppServerConnection>;
  private current?: AppServerConnection;
  private closed = false;
  private readonly connections = new Set<AppServerConnection>();

  constructor(private readonly config: AsyncCodexConfig) {}

  async callCodex(profile: ToolProfile, args: CodexToolArguments): Promise<CallToolResult> {
    const connection = await this.getConnection();
    const result = await connection.request("thread/start", {
      model: args.model ?? profile.model,
      cwd: args.cwd,
      sandbox: profile.sandboxMode,
      approvalPolicy: profile.approvalPolicy,
      baseInstructions: profile.baseInstructions,
      developerInstructions: profile.developerInstructions,
      config: { ...profile.config, ...(profile.compactPrompt ? { compact_prompt: profile.compactPrompt } : {}) },
    });
    if (typeof result?.thread?.id !== "string") throw new Error("Codex app-server thread/start did not return a thread id.");
    return connection.runTurn(result.thread.id, args.prompt);
  }

  async continueSession(sessionId: string, prompt: string, cwd?: string, profile?: ToolProfile): Promise<CallToolResult> {
    const connection = await this.getConnection();
    await connection.request("thread/resume", { threadId: sessionId, cwd,
      ...(profile ? { model: profile.model, sandbox: profile.sandboxMode, approvalPolicy: profile.approvalPolicy, baseInstructions: profile.baseInstructions, developerInstructions: profile.developerInstructions, config: { ...profile.config, ...(profile.compactPrompt ? { compact_prompt: profile.compactPrompt } : {}) } } : {}),
    });
    return connection.runTurn(sessionId, prompt, cwd);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections].map(connection => connection.close()));
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections].map(connection => connection.stop()));
  }

  private getConnection(): Promise<AppServerConnection> {
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed."));
    if (!this.connection) {
      const connection = new AppServerConnection(this.config, () => {
        if (this.current === connection) { this.connection = undefined; this.current = undefined; }
      });
      this.connections.add(connection);
      void connection.whenExited().then(() => this.connections.delete(connection));
      this.current = connection;
      this.connection = connection.initialize().then(() => connection).catch(async (error) => {
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
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly pending = new Map<number, Pending>();
  private readonly turns = new Map<string, Turn>();
  private nextId = 0;
  private failure?: Error;
  private readonly exited: Promise<void>;
  private hasExited = false;

  constructor(private readonly config: AsyncCodexConfig, private readonly disconnected: () => void) {
    // Translate the old explicit default as well as accepting custom launchers.
    const args = config.codex.args.map((arg) => arg === "mcp-server" ? "app-server" : arg);
    this.child = spawn(config.codex.command, args, {
      env: { ...process.env, ...config.codex.env }, cwd: config.codex.cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "inherit"],
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => { this.hasExited = true; resolve(); }));
    this.child.on("error", (error) => this.fail(new Error(`Cannot start Codex app-server: ${error.message}. Configure codex.command and codex.args for a CLI with app-server support.`)));
    this.child.on("close", (code, signal) => this.fail(new Error(`Codex app-server exited (code ${code}, signal ${signal}). This integration requires the app-server interface; verify codex.command and codex.args (tested with Codex 0.153.4 and 0.154.0).`)));
    this.child.stdin.on("error", (error) => this.fail(new Error(`Codex app-server input failed: ${error.message}`)));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error("Codex app-server emitted an invalid JSONL message.")); this.child.kill(); }
    });
    this.child.once("close", () => lines.close());
  }

  async initialize(): Promise<void> {
    try {
      await this.request("initialize", { clientInfo: { name: "async_codex_mcp", version: "0.7.1" } }, DEFAULT_REQUEST_TIMEOUT_MSEC);
      this.send({ method: "initialized", params: {} });
    } catch (error) {
      throw new Error(`Codex app-server initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  request(method: string, params: unknown, timeoutMs = this.config.codex.requestTimeoutSec * 1000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} exceeded its ${timeoutMs / 1000}s wait limit.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  runTurn(threadId: string, prompt: string, cwd?: string): Promise<CallToolResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.turns.has(threadId)) return Promise.reject(new Error(`Codex thread ${threadId} already has an active turn.`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(threadId);
        activeTurn.expired = true;
        this.interrupt(threadId, activeTurn);
        reject(new Error("Codex app-server turn exceeded codex.requestTimeoutSec."));
      }, this.config.codex.requestTimeoutSec * 1000);
      // Subscribe before turn/start: completion may arrive before its response.
      const activeTurn: Turn = { resolve, reject, timer, messages: new Map<string, string>() };
      this.turns.set(threadId, activeTurn);
      void this.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], cwd }).then((result) => {
        activeTurn.id = result?.turn?.id;
        if (activeTurn.expired) this.interrupt(threadId, activeTurn);
      }).catch((error) => {
        const turn = this.turns.get(threadId);
        if (turn === activeTurn) { clearTimeout(turn.timer); this.turns.delete(threadId); turn.reject(error); }
      });
    });
  }

  private interrupt(threadId: string, turn: Turn): void {
    if (turn.id && !turn.interruptRequested) {
      turn.interruptRequested = true;
      void this.request("turn/interrupt", { threadId, turnId: turn.id }).catch(() => {});
    }
  }

  private receive(message: any): void {
    if (message.method && message.id !== undefined) {
      // Interactive input uses the existing callback MCP tools. Never leave an
      // unsupported server request pending or silently approve an operation.
      this.send({ id: message.id, error: { code: -32601, message: `Unsupported app-server client request: ${message.method}. Use the async callback tools for user input.` } });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex app-server: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params;
    const turn = this.turns.get(params?.threadId);
    if (!turn) return;
    turn.id ??= params.turnId ?? params.turn?.id;
    turn.timer.refresh();
    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      turn.messages.set(params.item.id, params.item.text);
    }
    if (message.method === "turn/completed") {
      clearTimeout(turn.timer);
      this.turns.delete(params.threadId);
      const completed = params.turn;
      if (completed?.status !== "completed") {
        turn.reject(new Error(`Codex turn ${completed?.status ?? "unknown"}: ${completed?.error?.message ?? "Turn did not complete."}`));
        return;
      }
      for (const item of completed.items ?? []) {
        if (item.type === "agentMessage") turn.messages.set(item.id, item.text);
      }
      turn.resolve({ content: [...turn.messages.values()].map((text) => ({ type: "text", text })), _meta: { threadId: params.threadId } });
    }
  }

  private send(message: unknown): void {
    if (!this.failure) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    for (const turn of this.turns.values()) { clearTimeout(turn.timer); turn.reject(error); }
    this.pending.clear();
    this.turns.clear();
    this.disconnected();
  }

  whenExited(): Promise<void> { return this.exited; }

  private signal(signal: NodeJS.Signals): void {
    if (this.hasExited || !this.child.pid) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async stop(): Promise<void> {
    // Each server round owns this process group. Kill also covers initialization
    // before a thread/turn id exists, and never tears down another round.
    this.signal("SIGKILL");
    this.fail(new Error("Codex app-server session stopped."));
    await this.exited;
  }

  async close(): Promise<void> {
    this.signal("SIGTERM");
    this.fail(new Error("Codex app-server connection closed."));
    await this.exited;
  }
}
