import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AsyncCodexConfig, ToolProfile } from "./config.js";

export type CodexToolArguments = {
  prompt: string;
  model?: string;
  cwd?: string;
};

export type CodexClientLike = {
  callCodex(profile: ToolProfile, args: CodexToolArguments): Promise<CallToolResult>;
  continueSession(sessionId: string, prompt: string, cwd?: string): Promise<CallToolResult>;
  close(): Promise<void>;
};

export class CodexMcpClient implements CodexClientLike {
  private client?: Client;
  private transport?: StdioClientTransport;

  constructor(private readonly config: AsyncCodexConfig) {}

  async callCodex(profile: ToolProfile, args: CodexToolArguments): Promise<CallToolResult> {
    const client = await this.getClient();
    const codexArgs: Record<string, unknown> = {
      prompt: args.prompt,
      sandbox: profile.sandboxMode,
      "approval-policy": profile.approvalPolicy,
    };

    const model = args.model ?? profile.model;
    if (model) codexArgs.model = model;
    if (args.cwd) codexArgs.cwd = args.cwd;

    if (profile.baseInstructions) codexArgs["base-instructions"] = profile.baseInstructions;
    if (profile.compactPrompt) codexArgs["compact-prompt"] = profile.compactPrompt;
    if (profile.developerInstructions) codexArgs["developer-instructions"] = profile.developerInstructions;
    if (Object.keys(profile.config).length > 0) codexArgs.config = profile.config;

    return client.callTool({ name: "codex", arguments: codexArgs }, undefined, this.requestOptions()) as Promise<CallToolResult>;
  }

  async continueSession(sessionId: string, prompt: string, cwd?: string): Promise<CallToolResult> {
    const client = await this.getClient();
    const args: Record<string, unknown> = { threadId: sessionId, prompt };
    if (cwd) args.cwd = cwd;
    return client.callTool({ name: "codex-reply", arguments: args }, undefined, this.requestOptions()) as Promise<CallToolResult>;
  }

  // The SDK default request timeout is 60s, which aborts any Codex run
  // longer than a minute regardless of callback state.
  private requestOptions() {
    return { timeout: this.config.codex.requestTimeoutSec * 1000, resetTimeoutOnProgress: true };
  }

  async close(): Promise<void> {
    await this.client?.close();
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;

    this.client = new Client({ name: "async-codex-mcp-client", version: "0.2.0" });
    this.transport = new StdioClientTransport({
      command: this.config.codex.command,
      args: this.config.codex.args,
      env: { ...process.env, ...this.config.codex.env } as Record<string, string>,
      cwd: this.config.codex.cwd,
      stderr: "inherit",
    });
    await this.client.connect(this.transport);
    return this.client;
  }
}
