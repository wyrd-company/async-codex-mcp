# async-codex-mcp

Async Codex MCP server.

This package implements an MCP server that drives the Codex app-server and turns blocking `codex` calls into background sessions. Configured profile tools return immediately with an async session id; clients can inspect session state, receive completion events, and resume completed sessions even after Claude or the MCP server restarts.

## Why

The Codex CLI exposes a JSONL API through `codex app-server`. This server adapts its thread and turn APIs to:

- expose named, opinionated profile tools from YAML configuration;
- restrict caller-controlled inputs to `prompt`, `model`, and `cwd`;
- default Codex execution to `sandboxMode: danger-full-access` and `approvalPolicy: never` for devcontainer use;
- return immediately while Codex runs in the background;
- persist the wrapper-to-Codex session mapping across MCP server restarts;
- send MCP logging notifications when a background session completes or fails;
- expose `continue-session` through `thread/resume` and `turn/start`.

## Compatibility

Requires Node.js 20 or later and a Codex CLI with the app-server v2 thread/turn API. Codex `0.153.4` and `0.154.0` are tested, including thread resumption after restarting the app-server process. Other releases are checked by the app-server initialization handshake, without a pinned runtime version check. A missing interface produces a named app-server startup error in `session-status`.

The default command is `codex app-server`. An explicit legacy `mcp-server` argument in existing YAML is translated to `app-server`; custom command launchers remain supported. Profiles retain their model, working directory, sandbox, approval policy, instructions, and config overrides. `compactPrompt` maps to the Codex `compact_prompt` config key. Interactive app-server client requests are reported as unsupported; user questions use the callback tools described below.

The stdio endpoint supports MCP `2026-07-28` through per-request metadata and `server/discover`, with legacy `initialize` fallback for `2025-11-25` and earlier SDK-supported revisions. Modern results include `resultType`. Unsupported modern versions return the protocol's supported-version error so clients can retry. Legacy clients retain logging and Claude channel notifications. Modern clients read background results through `session-status` or the watcher; the server does not send unsolicited modern notifications.

Upstream contracts: [Codex app-server](https://developers.openai.com/codex/app-server) and [MCP versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle).

## Install

```bash
npm install --global @wyrd-company/async-codex-mcp
```

## Configuration

Pass a YAML file path as the first CLI argument, or set `ASYNC_CODEX_MCP_CONFIG`. If no config is provided, a single `codex` profile is created with `danger-full-access` sandboxing and `never` approval policy.

Callbacks are enabled by default. `callbacks.askTimeoutSec` (default 3600, also settable per tool under `tools.<name>.callbacks`) is passed to Codex as the callback MCP server's `tool_timeout_sec` — the ceiling on how long a blocking `async_codex_ask_user` call can wait for an answer. Without it, Codex aborts blocked asks at its default 60-second tool timeout and the session fails.

`codex.requestTimeoutSec` (default 86400) sets the app-server request and turn wait limit. Turn notifications reset the turn wait limit; expiry requests a turn interruption. Initialization retains the previous 60-second SDK connection limit. Codex diagnostics go to stderr, separate from tool results.

Example:

```yaml
codex:
  command: codex
  args: [app-server]
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

Tool `config` values are passed through to the app-server `thread/start` request as Codex config overrides. For example, this exposes a separate tool that routes through an Azure/OpenAI-compatible provider:

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

An MCP process cannot restore a live promise or callback connection. Records left as `running` or `waiting_for_input` whose owning process is no longer live are recovered as `interrupted`; they never appear to the Stop hook or watcher as live work. Durable records contain the session prompt, result, callback messages, and working-directory metadata needed by `session-status`, but never callback bearer tokens or provider credentials.

### Session retention

The server prunes terminal session records during startup, session creation, continuation, and terminal transitions. Active records are never pruned. Completed records updated within the protection window remain available for `continue-session`, even when the record cap is exceeded. Defaults are conservative:

```yaml
retention:
  maxAgeDays: 365
  maxRecords: 10000
  protectRecentDays: 90
```

`maxAgeDays` removes older completed, failed, interrupted, and stopped records. `maxRecords` removes the oldest unprotected terminal records when the retained terminal record count exceeds the cap. Set either value to `0` for unlimited retention by that rule. Set `protectRecentDays` to `0` to disable the completed-session protection window.

Cleanup is best effort. Malformed or unreadable records remain untouched, and a record changed by another server during cleanup is retained for a later pass. Temporary server and watcher snapshots are also reaped when their recorded PID is dead or its process start identity no longer matches.

For manual cleanup, remove selected session JSON files from `${ASYNC_CODEX_MCP_SESSION_DIR}` or `${XDG_STATE_HOME:-$HOME/.local/state}/async-codex-mcp/sessions/`. Remove temporary snapshots from `${ASYNC_CODEX_MCP_STATE_DIR}` or the `async-codex-mcp-state` directory under the operating system temporary directory. Keep records whose sessions are active in another MCP server.

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
- `kind="completed"` / `kind="failed"` / `kind="stopped"`: the session finished

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

Set `ASYNC_CODEX_MCP_STOP_HOOK=off` to disable the hook without uninstalling the plugin. Codex runs are capped by `codex.requestTimeoutSec`. Callback tool calls receive `callbacks.askTimeoutSec` as their Codex-side timeout; if Codex does not terminate the run after that timeout, the overall request timeout remains the final bound.

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
- Exits — removing its registration file — as soon as either every matched session has settled (`completed`/`failed`/`interrupted`/`stopped`), or any session starts `waiting_for_input`. The latter needs Claude back regardless of what else is still running, so the watcher hands control back immediately rather than waiting for everything to finish.

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

## Continuation rounds and callback lifetime

A session retains its wrapper ID and native Codex thread ID across continuations. `round` starts at 1 and increases for each continuation. `session-status` reports the current round; a running continuation clears the previous result, then stores its new result or failure. Continuation remains a blocking MCP call. Channels and the watcher also observe its running, waiting, and terminal transitions.

Each active round owns an app-server process. A continuation resumes the durable native thread in a fresh process with current callback configuration. This avoids the app-server behavior that ignores configuration overrides on already-loaded threads. Callback processes receive a round-scoped lifecycle response when the round ends and exit even if their stdin remains open. Delayed callbacks from an earlier round cannot change the current round.

### Stopping a session

Call `stop-session` with `session_id` to stop a `running` or `waiting_for_input` session through the MCP server that owns its active round. The tool terminates that round's app-server process and waits for process exit before returning `stopped`. Other sessions keep their own processes. Pending questions are rejected, callbacks close, and `stopped` is terminal for notifications, the Stop hook, and the watcher. Unknown or terminal sessions return an error without changing the record; `answer-session` and `continue-session` reject stopped sessions.

The app-server exposes `turn/interrupt`, which requires a thread and turn ID. Explicit stop uses process termination so it also works during initialization, before those IDs exist. On POSIX systems, the round owns a process group and stop sends `SIGKILL` to that group. On Windows, stop terminates the app-server child process. Stop cannot undo completed side effects or guarantee termination of independently detached or remote work. Custom injected library clients must implement `stop()` with isolated ownership to expose this operation. Normal cleanup sends `SIGTERM` and waits for exit; a custom launcher that ignores that signal can delay cleanup.
