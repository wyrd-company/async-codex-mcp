// ---
// relationships:
//   verifies: codex-client
// ---
// Optional integration probe: build first, then run beside an existing server.
// All model traffic goes to a local synthetic provider; no credentials are used.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import WebSocket from "ws";
import { CodexAppServerClient } from "../dist/src/codex-client.js";
import { loadConfig } from "../dist/src/config.js";

const held = new Map();
const requests = [];
const provider = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!request.url.startsWith("/mcp/")) requests.push(body);
  if (request.url.startsWith("/mcp/")) {
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "sample_callback", version: "1.0.0" },
          }
        : body.method === "tools/list"
          ? {
              tools: [
                {
                  name: request.url.endsWith("two")
                    ? "sample_round_two"
                    : "sample_round_one",
                  description: "Sample callback tool.",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {};
    if (body.id === undefined) {
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }
    return;
  }
  const text = body.input
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "input_text")
    .at(-1)?.text;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (value) =>
    response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: "response.created", response: { id: "sample-response" } });
  const finish = () => {
    event({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "sample-message",
        content: [{ type: "output_text", text: "Sample result." }],
      },
    });
    event({
      type: "response.completed",
      response: {
        id: "sample-response",
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    response.end();
  };
  if (text?.startsWith("hold:")) held.set(text, { finish, response });
  else finish();
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const config = loadConfig();
const profile = {
  ...config.tools.codex,
  model: "gpt-5.4",
  sandboxMode: "read-only",
  config: {
    model_provider: "sample",
    model_providers: {
      sample: {
        name: "Sample provider",
        base_url: `http://127.0.0.1:${provider.address().port}`,
        wire_api: "responses",
        requires_openai_auth: false,
      },
    },
  },
};
const roundProfile = (round) => ({
  ...profile,
  config: {
    ...profile.config,
    mcp_servers: {
      sample: {
        url: `http://127.0.0.1:${provider.address().port}/mcp/${round}`,
      },
    },
  },
});
const clients = [];
const client = () => {
  const value = new CodexAppServerClient(config);
  clients.push(value);
  return value;
};
const endpoint = process.env.CODEX_APP_SERVER_URL;
assert.ok(
  endpoint?.startsWith("unix://"),
  "Set CODEX_APP_SERVER_URL to the existing Unix socket.",
);
const observer = new WebSocket("ws://localhost", {
  createConnection: () => net.createConnection(endpoint.slice(7)),
});
await new Promise((resolve, reject) => {
  observer.once("open", resolve);
  observer.once("error", reject);
});
let sequence = 0;
const pending = new Map();
observer.on("message", (data) => {
  const message = JSON.parse(data);
  const request = pending.get(message.id);
  if (request) {
    pending.delete(message.id);
    message.error
      ? request.reject(new Error(message.error.message))
      : request.resolve(message.result);
  }
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = sequence++;
    pending.set(id, { resolve, reject });
    observer.send(JSON.stringify({ id, method, params }));
  });
const until = async (predicate) => {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 10));
};
try {
  await rpc("initialize", {
    clientInfo: { name: "sample_observer", version: "1.0.0" },
  });
  observer.send(JSON.stringify({ method: "initialized", params: {} }));
  const a = client();
  const first = await a.callCodex(roundProfile("one"), {
    prompt: "Sample first turn.",
    cwd: "/tmp",
  });
  assert.deepEqual(first.content, [{ type: "text", text: "Sample result." }]);
  await rpc("thread/resume", { threadId: first._meta.threadId });
  await a.close();
  const second = await client().continueSession(
    first._meta.threadId,
    "Sample second turn.",
    "/tmp",
    roundProfile("two"),
  );
  assert.notEqual(second._meta.threadId, first._meta.threadId);
  assert.ok(
    JSON.stringify(requests.at(-1).tools).includes("sample_round_two"),
    "Fork must expose the current callback tool",
  );
  assert.ok(
    !JSON.stringify(requests.at(-1).tools).includes("sample_round_one"),
    "Fork must discard the ended callback tool",
  );
  assert.ok(
    JSON.stringify(requests.at(-1).input).includes("Sample first turn."),
    "Fork must retain conversation history",
  );
  const stopped = client(),
    other = client();
  const stopResult = stopped
    .callCodex(profile, { prompt: "hold:alpha", cwd: "/tmp" })
    .then(
      () => {
        throw new Error("Stopped turn completed");
      },
      (error) => error,
    );
  const otherResult = other.callCodex(profile, {
    prompt: "hold:beta",
    cwd: "/tmp",
  });
  await until(() => held.size === 2);
  await stopped.stop();
  assert.match((await stopResult).message, /interrupted|closed/);
  const loaded = await rpc("thread/loaded/list", {});
  assert.ok(
    loaded.data.includes(first._meta.threadId),
    "Observer's original thread remains loaded",
  );
  assert.equal(
    held.get("hold:beta").response.destroyed,
    false,
    "Other turn remains active",
  );
  held.get("hold:beta").finish();
  assert.deepEqual((await otherResult).content, [
    { type: "text", text: "Sample result." },
  ]);
  console.log(
    "Native shared-server adapter: turns, subscribed-source fork, history, fresh callback configuration, isolated stop and observer survival passed.",
  );
} finally {
  await Promise.all(clients.map((value) => value.close()));
  observer.terminate();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
