// ---
// relationships:
//   verifies: codex-client
// ---
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

/** A real WebSocket listener with shared thread state, owned by the test. */
export async function appServerFixture(
  options: {
    holdInitialize?: boolean;
    delayTurnStart?: boolean;
    delayThreadStart?: boolean;
    rejectInterrupt?: boolean;
  } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sample-app-server-"),
  );
  const socketPath = path.join(directory, "server.sock");
  const httpServer = http.createServer();
  const server = new WebSocketServer({ server: httpServer });
  const threads = new Map<string, any>();
  const requests: any[] = [];
  const held = new Map<
    string,
    { socket: WebSocket; threadId: string; turnId: string }
  >();
  const subscribers = new Map<string, Set<WebSocket>>();
  const acknowledgements: (() => void)[] = [];
  let sequence = 0;
  let connected = 0;
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  const complete = (
    socket: WebSocket,
    threadId: string,
    turnId: string,
    status: string,
    text?: string,
  ) => {
    const notification = {
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status,
          items: text ? [{ id: "message", type: "agentMessage", text }] : [],
          error: status === "failed" ? { message: "fixture failure" } : null,
        },
      },
    };
    for (const client of server.clients) send(client, notification);
  };
  server.on("connection", (socket) => {
    connected++;
    let initialized = false;
    socket.on("close", () => {
      for (const set of subscribers.values()) set.delete(socket);
    });
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const { id, method, params } = request;
      if (method === "initialize") {
        if (!options.holdInitialize)
          send(socket, { id, result: { userAgent: "fixture" } });
        return;
      }
      if (method === "initialized") {
        initialized = true;
        return;
      }
      if (!initialized) {
        send(socket, { id, error: { message: "Not initialized" } });
        return;
      }
      if (
        method === "thread/start" ||
        method === "thread/resume" ||
        method === "thread/fork"
      ) {
        const threadId =
          method !== "thread/resume" ? `thread-${++sequence}` : params.threadId;
        // Like Codex, a subscribed loaded thread retains its original config.
        if (!subscribers.get(threadId)?.size)
          threads.set(
            threadId,
            method === "thread/fork"
              ? {
                  ...threads.get(params.threadId),
                  ...params,
                  forkedFrom: params.threadId,
                }
              : method === "thread/start"
                ? params
                : { resumed: true, ...params },
          );
        const set = subscribers.get(threadId) ?? new Set();
        set.add(socket);
        subscribers.set(threadId, set);
        const reply = () =>
          send(socket, { id, result: { thread: { id: threadId } } });
        if (options.delayThreadStart) acknowledgements.push(reply);
        else reply();
        return;
      }
      if (method === "thread/unsubscribe") {
        subscribers.get(params.threadId)?.delete(socket);
        send(socket, { id, result: { status: "unsubscribed" } });
        return;
      }
      if (method === "turn/interrupt") {
        if (options.rejectInterrupt) {
          send(socket, { id, error: { message: "Interruption rejected" } });
          return;
        }
        complete(socket, params.threadId, params.turnId, "interrupted");
        send(socket, { id, result: {} });
        return;
      }
      if (method === "turn/start") {
        const text = params.input[0].text;
        if (text === "crash") {
          for (const client of server.clients) client.terminate();
          return;
        }
        if (text === "invalid") {
          socket.send("not-json");
          return;
        }
        if (text === "rpc-error") {
          send(socket, { id, error: { message: "Invalid turn" } });
          return;
        }
        if (text === "request")
          send(socket, {
            id: "server-request",
            method: "sample/unsupported",
            params: { threadId: params.threadId },
          });
        const turnId = `turn-${params.threadId}`;
        if (text.startsWith("hold"))
          held.set(text, { socket, threadId: params.threadId, turnId });
        else {
          const result = JSON.stringify({
            text,
            profile: threads.get(params.threadId),
          });
          for (const client of server.clients)
            send(client, {
              method: "item/completed",
              params: {
                threadId: params.threadId,
                turnId,
                item: { id: "message", type: "agentMessage", text: result },
              },
            });
          complete(
            socket,
            params.threadId,
            turnId,
            text === "fail"
              ? "failed"
              : text === "interrupt"
                ? "interrupted"
                : "completed",
          );
        }
        const reply = () =>
          send(socket, { id, result: { turn: { id: turnId } } });
        if (options.delayTurnStart) acknowledgements.push(reply);
        else reply();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(socketPath, resolve);
  });
  return {
    endpoint: `unix://${socketPath}`,
    directory,
    requests,
    threads,
    held,
    get connections() {
      return connected;
    },
    notify(message: unknown) {
      for (const client of server.clients) send(client, message);
    },
    acknowledge() {
      for (const reply of acknowledgements.splice(0)) reply();
    },
    finish(key: string) {
      const turn = held.get(key);
      if (!turn) throw new Error("No held turn");
      complete(
        turn.socket,
        turn.threadId,
        turn.turnId,
        "completed",
        "finished " + key,
      );
      held.delete(key);
    },
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
