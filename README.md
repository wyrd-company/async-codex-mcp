# async-codex-mcp
Async codex MCP server

## Problems

The Codex CLI can be ran as an MCP server `codex mcp-server` which provides tools for other agent harnesses, like Claude, to use Codex as sub-agents.

The tool exposes two tools, `codex` and `codex-reply`.

**Problem 1**: `codex` is blocking. We need to transform this into a asynchronous process.

The `codex` tool also provides a number of parameters for how to call codex.

**Problem 2**: The agents keep setting incorrect parameter values for the environment, specifically the sandbox mode. In my case the sandbox should be danger full permissions since we are already running in a devcontainer and bwrap does not operate correctly and we already have a safe environment.

## Opportunities

IF we also assume that Claude is the harness being used (it is), then we can take advantage of Claude [channels](https://code.claude.com/docs/en/channels) to make the async workflow even better.

We also can take advantage of Codex profiles to also provide access to non-OpenAI models.

## Proposal

Create a MCP Server, in typescript, that hosts a MCP client that can be configured to use codex in MCP mode.

Proxy the `codex` tool into multiple tools with specific configurations.

Each tool would have a name, and only `prompt`, `model`, and `cwd` options.

The server would read a YAML configuration file to configure the different tool profiles.

Tool profiles would allow setting all of the other `codex` settings.

`codex-reply` would be re-exposed as a more generic `continue-session` tool that would allow resuming a completed session.

THe server would expose a channel allowing Claude to be notified when the session `stop` happens.

### Stretch

IF it is possible to interface with codex in such a way that a combination channels and tool calls could allow the supervising agent to _steer_ the conversation, that would be awesome.
