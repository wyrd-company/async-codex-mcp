#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readStateFiles } from "./state-file.js";
import { ancestorPids, evaluateStopHook } from "./stop-hook.js";
import { readWatcherFiles } from "./watcher-file.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.env.ASYNC_CODEX_MCP_STOP_HOOK !== "off") {
  let sessionId: string | undefined;
  try {
    sessionId = (JSON.parse(await readStdin()) as { session_id?: string }).session_id;
  } catch {
    // No/invalid stdin payload; fall back to ancestry matching only.
  }

  const watcherCliPath = fileURLToPath(new URL("./codex-watch-cli.js", import.meta.url));
  const watcherCommand = `node "${watcherCliPath}"`;

  const decision = evaluateStopHook(readStateFiles(), readWatcherFiles(), { sessionId, ancestors: () => ancestorPids() }, watcherCommand);
  if (decision) console.log(JSON.stringify(decision));
}
