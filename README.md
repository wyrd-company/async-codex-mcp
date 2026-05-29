# async-codex-mcp

Async Codex MCP server.

This package implements an MCP server that proxies a Codex MCP server and turns blocking `codex` calls into background sessions. Configured profile tools return immediately with an async session id; clients can poll `session-status`, receive `notifications/message` completion events, and resume completed Codex sessions with `continue-session`.

## Why

The Codex CLI can run as an MCP server with `codex mcp-server`, exposing blocking `codex` and `codex-reply` tools. This server wraps those tools to:

- expose named, opinionated profile tools from YAML configuration;
- restrict caller-controlled inputs to `prompt`, `model`, and `cwd`;
- default Codex execution to `sandboxMode: danger-full-access` and `approvalPolicy: never` for devcontainer use;
- return immediately while Codex runs in the background;
- send MCP logging notifications when a background session completes or fails;
- expose `continue-session` as a generic wrapper around `codex-reply`.

## Install and build

```bash
npm install
npm run build
```

## Configuration

Pass a YAML file path as the first CLI argument, or set `ASYNC_CODEX_MCP_CONFIG`. If no config is provided, a single `codex` profile is created with `danger-full-access` sandboxing and `never` approval policy.

Example:

```yaml
codex:
  command: codex
  args: [mcp-server]
  env: {}

tools:
  codex-write:
    description: Run Codex asynchronously with full filesystem access.
    sandboxMode: danger-full-access
    approvalPolicy: never
  codex-review:
    description: Ask Codex to review code without making edits.
    sandboxMode: read-only
    approvalPolicy: never
```

## Run

```bash
node dist/src/cli.js ./fixtures/async-codex-mcp.yaml
```

Each configured profile becomes an MCP tool that accepts:

- `prompt` (required): prompt to send to Codex;
- `model` (optional): model override, for example `gpt-5.4-mini`;
- `cwd` (optional): working directory for the run.

The profile tool returns JSON with an async `session_id` and `running` status. Use `session-status` with that id to inspect completion state. When complete, use `continue-session` with the async session id and a new `prompt` to resume the underlying Codex session.

## Development

```bash
npm test
npm run build
```

The test suite uses ThoughtSpot's `mcp-testing-kit` transport approach to exercise the MCP server directly and validates a `gpt-5.4-mini` model override without making network calls.
