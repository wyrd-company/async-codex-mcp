# async-codex-mcp

Async Codex MCP server.

This package implements an MCP server that proxies a Codex MCP server and turns blocking `codex` calls into background sessions. Configured profile tools return immediately with an async session id; clients can inspect session state, receive completion events, and resume completed sessions even after Claude or the MCP server restarts.

## Why

The Codex CLI can run as an MCP server with `codex mcp-server`, exposing blocking `codex` and `codex-reply` tools. This server wraps those tools to:

- expose named, opinionated profile tools from YAML configuration;
- restrict caller-controlled inputs to `prompt`, `model`, and `cwd`;
- default Codex execution to `sandboxMode: danger-full-access` and `approvalPolicy: never` for devcontainer use;
- return immediately while Codex runs in the background;
- persist the wrapper-to-Codex session mapping across MCP server restarts;
- send MCP logging notifications when a background session completes or fails;
- expose `continue-session` as a generic wrapper around `codex-reply`.

## Install

```bash
npm install --global @wyrd-company/async-codex-mcp
```

## Configuration

Pass a YAML file path as the first CLI argument, or set `ASYNC_CODEX_MCP_CONFIG`. If no config is provided, a single `codex` profile is created with `danger-full-access` sandboxing and `never` approval policy.

Callbacks are enabled by default. `callbacks.askTimeoutSec` (default 3600, also settable per tool under `tools.<name>.callbacks`) is passed to Codex as the callback MCP server's `tool_timeout_sec` — the ceiling on how long a blocking `async_codex_ask_user` call can wait for an answer. Without it, Codex aborts blocked asks at its default 60-second tool timeout and the session fails.

`codex.requestTimeoutSec` (default 86400) sets the MCP request timeout for this server's own `codex`/`codex-reply` calls into the Codex MCP server. The SDK default is 60 seconds, which aborts any Codex run longer than a minute with `MCP error -32001`.

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

Tool `config` values are passed through to the underlying Codex MCP `codex` tool as Codex config overrides. For example, this exposes a separate tool that routes through an Azure/OpenAI-compatible provider:

```yaml
tools:
  codex-azure-review:
    description: Ask Codex to review code using Azure OpenAI.
    sandboxMode: read-only
    approvalPolicy: never
    model: gpt-5-codex
    config:
      model_provider: azure
      model_providers:
        azure:
          name: Azure
          base_url: https://YOUR_RESOURCE_NAME.openai.azure.com/openai
          wire_api: responses
          query_params:
            api-version: 2025-04-01-preview
          env_key: AZURE_OPENAI_API_KEY
```

Keep API keys in environment variables, not YAML. In the example above, Codex reads the provider key from `AZURE_OPENAI_API_KEY`.

Callbacks are enabled by default. For each async session, this wrapper injects a session-scoped MCP server into Codex with two tools:

- `async_codex_ask_user`: blocking; Codex sends `message` plus optional `context` and waits until the async session is answered.
- `async_codex_notify_user`: non-blocking; Codex sends `message` plus optional `topic` and keeps working.

Use `answer-session` to respond when `session-status` reports `waiting_for_input`.

Disable callbacks globally:

```yaml
callbacks:
  enabled: false
```

Or disable them for one configured tool:

```yaml
tools:
  codex-review:
    description: Ask Codex to review code without making edits.
    sandboxMode: read-only
    approvalPolicy: never
    callbacks:
      enabled: false
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

### Durable sessions

The wrapper writes one atomic JSON record per async session under `${XDG_STATE_HOME:-$HOME/.local/state}/async-codex-mcp/sessions/`. Set `ASYNC_CODEX_MCP_SESSION_DIR` to override that directory. Directories are created for the current operating-system user with mode `0700`; records use mode `0600`.

Completed and failed records load when a new MCP server starts. A completed record retains the native Codex thread ID, so the original async `session_id` continues to work with `session-status` and `continue-session` after Claude, the MCP server, or the device restarts.

An MCP process cannot restore a live promise or callback connection. Records left as `running` or `waiting_for_input` are therefore recovered as `interrupted`; they never appear to the Stop hook or watcher as live work. Durable records contain the session prompt, result, callback messages, and working-directory metadata needed by `session-status`, but never callback bearer tokens or provider credentials. They are retained until the user removes the session directory.

If a session is waiting for input, answer it with:

```json
{
  "session_id": "<async-session-id>",
  "message": "Use staging."
}
```

## Claude Code plugin

This package is also the `async-codex-mcp` Claude Code plugin: `.claude-plugin/plugin.json` and `.mcp.json` sit at the package root, and the MCP server runs from the self-contained bundle at `dist/bundle/cli.js`. The marketplace manifest lives in the dedicated Wyrd Company plugin marketplace repository.

## Claude Code channels

The server declares the experimental `claude/channel` capability. When a session opts in, callback and lifecycle events are pushed directly into Claude's context as `<channel source="async-codex-mcp" session_id="..." kind="...">` events instead of requiring `session-status` polling:

- `kind="notify"`: non-blocking progress update (with a `topic` attribute when set)
- `kind="ask"`: Codex is blocked waiting for input; Claude answers with `answer-session`
- `kind="completed"` / `kind="failed"`: the session finished

Channels are a Claude Code research preview (v2.1.80+). This plugin is not on the Anthropic-curated channel allowlist, so each session must opt in with the development flag:

```bash
claude --dangerously-load-development-channels plugin:async-codex-mcp@wyrd-company
```

`bin/claude-channels-wrapper.sh` wraps that invocation. In the VSCode extension, point the `claudeCode.claudeProcessWrapper` setting at the script inside the installed plugin, for example:

```json
{
  "claudeCode.claudeProcessWrapper": "/home/vscode/.claude/plugins/cache/wyrd-company/async-codex-mcp/unknown/bin/claude-channels-wrapper.sh"
}
```

From a terminal, run the script directly in place of `claude`. Without the flag the plugin still works; events are simply not injected and `session-status` polling applies.

## Stop hook: keeping Claude engaged

Until channel injection is broadly available, Claude tends to start an async Codex session and end its turn — leaving the session unmonitored. The plugin ships a `Stop` hook (`hooks/hooks.json`) that blocks Claude from stopping while sessions started in the same conversation are still `running` or `waiting_for_input`, unless a watcher process (see below) is already monitoring them.

How it works:

- The MCP server writes a temporary live-session snapshot on every state change to `$TMPDIR/async-codex-mcp-state/<server-pid>.json` (override with `ASYNC_CODEX_MCP_STATE_DIR`). This is separate from durable resumable records and contains only sessions owned by that process. The file is removed on clean shutdown.
- On `Stop`, the hook matches snapshots against the hook's `session_id` (exact), falling back to process ancestry for cases where the session id rotates but the Claude process and its MCP server persist (e.g. `/clear`). Snapshots from dead server processes are ignored.
- If a matched session is `waiting_for_input`, the hook always blocks — only Claude can answer it via `answer-session`.
- If matched sessions are only `running`, the hook computes which sessions are covered by live watchers. It blocks with the exact installed-plugin command while any session is uncovered.

Set `ASYNC_CODEX_MCP_STOP_HOOK=off` to disable the hook without uninstalling the plugin. Sessions cannot block forever: Codex runs are capped by `codex.requestTimeoutSec` and blocked asks by `callbacks.askTimeoutSec`, after which sessions transition to `failed` and the hook releases.

## Watching sessions in the background

`codex-watch-cli.js` is a small CLI meant to be launched as a background shell task instead of having Claude poll `session-status` in a sleep loop. The Stop hook prints an absolute bundled command that works from the Claude plugin cache. A global npm installation additionally exposes that CLI on `PATH` as `async-codex-mcp-watch`.

With no arguments, the watcher covers every live session matching the current `CLAUDE_CODE_SESSION_ID` or process ancestry:

```bash
async-codex-mcp-watch
```

To cover one async wrapper session independently:

```bash
async-codex-mcp-watch --session-id <async-session-id>
```

On start it:

- Excludes snapshots whose owning MCP server is dead, then selects sessions in the requested scope.
- If a matched session is already `waiting_for_input` (Codex called `async_codex_ask_user`), it reports that immediately and exits without registering — only Claude can answer it, so there's nothing to watch in the background yet.
- Otherwise it registers its exact conversation or session coverage in `$TMPDIR/async-codex-mcp-state/watchers/<watcher-pid>.json`. The Stop hook allows Claude to stop only when every running session has live watcher coverage.
- Polls every `ASYNC_CODEX_MCP_WATCH_INTERVAL_MS` (default `10000`), printing status changes and every new `notify` message in creation order. Existing notifications replay once when a watcher starts; unchanged snapshots do not duplicate them within that watcher process. Notification text can be time-sensitive.
- Exits — removing its registration file — as soon as either every matched session has settled (`completed`/`failed`), or any session starts `waiting_for_input`. The latter needs Claude back regardless of what else is still running, so the watcher hands control back immediately rather than waiting for everything to finish.

Because it's a normal background process, the harness notifies Claude when it exits (or Claude can attach `Monitor` to stream its status-change lines as they happen) — no polling loop required in the conversation itself.

## Publishing

The package is published publicly to npm as `@wyrd-company/async-codex-mcp`. Publishing is handled by the `Publish Package` GitHub Actions workflow, which runs tests, builds the package, and publishes with the repository `NPM_TOKEN` secret.

Run it manually from GitHub Actions, or push a SemVer tag without a `v` prefix, for example `0.1.0`.

## Development

```bash
npm test
npm run build
```

The test suite uses ThoughtSpot's `mcp-testing-kit` transport approach to exercise the MCP server directly and validates a `gpt-5.4-mini` model override without making network calls.
