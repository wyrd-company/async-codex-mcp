#!/bin/sh
# Launch Claude Code with async-codex-mcp channel support enabled.
#
# Channels are a Claude Code research preview and this plugin is not on the
# Anthropic-curated allowlist, so each session must opt in with the
# development flag. This wrapper appends that flag to whatever Claude
# command it is asked to run.
#
# Usage:
#   - VSCode: set the "claudeCode.claudeProcessWrapper" setting to this
#     script's path. The extension invokes it with the real Claude command
#     (binary and arguments) as "$@".
#   - Terminal: run it directly in place of `claude`; any arguments are
#     passed through (e.g. `claude-channels-wrapper.sh -p "hello"`).
case "${1:-}" in
  "" | -*) set -- claude "$@" ;;
esac
exec "$@" --dangerously-load-development-channels plugin:async-codex-mcp@wyrd-company
