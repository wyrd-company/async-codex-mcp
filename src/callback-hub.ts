import http from "node:http";
import type { Socket } from "node:net";

type CallbackHubRequest = {
  session_id: string;
  message: string;
  context?: string;
  topic?: string;
};

export type CallbackHubHandlers = {
  ask(input: { sessionId: string; message: string; context?: string }): Promise<string>;
  notify(input: { sessionId: string; message: string; topic?: string }): Promise<void>;
};

export type CallbackHubConnection = {
  url: string;
  token: string;
};

export class CallbackHub {
  private server?: http.Server;
  private connection?: CallbackHubConnection;
  private readonly token = crypto.randomUUID();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly handlers: CallbackHubHandlers) {}

  async ensureStarted(): Promise<CallbackHubConnection> {
    if (this.connection) return this.connection;

    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Callback hub did not bind to a TCP port.");
    }

    this.connection = {
      url: `http://127.0.0.1:${address.port}`,
      token: this.token,
    };
    return this.connection;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.connection = undefined;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST") {
        this.writeJson(response, 405, { error: "Only POST is supported." });
        return;
      }

      if (request.headers.authorization !== `Bearer ${this.token}`) {
        this.writeJson(response, 401, { error: "Invalid callback token." });
        return;
      }

      const body = await readJson(request);
      const parsed = parseCallbackRequest(body);
      if (!parsed.ok) {
        this.writeJson(response, 400, { error: parsed.error });
        return;
      }

      if (request.url === "/ask") {
        const answer = await this.handlers.ask({
          sessionId: parsed.value.session_id,
          message: parsed.value.message,
          context: parsed.value.context,
        });
        this.writeJson(response, 200, { answer });
        return;
      }

      if (request.url === "/notify") {
        await this.handlers.notify({
          sessionId: parsed.value.session_id,
          message: parsed.value.message,
          topic: parsed.value.topic,
        });
        this.writeJson(response, 200, { delivered: true });
        return;
      }

      this.writeJson(response, 404, { error: "Unknown callback endpoint." });
    } catch (error) {
      this.writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function parseCallbackRequest(body: unknown): { ok: true; value: CallbackHubRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be an object." };
  }

  const value = body as Record<string, unknown>;
  if (typeof value.session_id !== "string" || !value.session_id) {
    return { ok: false, error: "session_id is required." };
  }
  if (typeof value.message !== "string" || !value.message) {
    return { ok: false, error: "message is required." };
  }
  if (value.context !== undefined && typeof value.context !== "string") {
    return { ok: false, error: "context must be a string." };
  }
  if (value.topic !== undefined && typeof value.topic !== "string") {
    return { ok: false, error: "topic must be a string." };
  }

  return {
    ok: true,
    value: {
      session_id: value.session_id,
      message: value.message,
      context: value.context,
      topic: value.topic,
    },
  };
}
