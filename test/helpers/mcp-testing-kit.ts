import { consola } from "consola";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJSONRPCError, isJSONRPCNotification, JSONRPCMessage, JSONRPCNotification, JSONRPCResponse, ListToolsResult, JSONRPCError, ListResourcesResult, ProgressNotificationSchema, ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, JSONRPCRequest, Request, ListPromptsRequestSchema, ListPromptsResult, isJSONRPCResponse, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";

class TestTransport implements Transport {
    constructor(private recieverCb: (message: JSONRPCMessage) => void) { }

    async send(message: JSONRPCMessage) {
        this.recieverCb(message);
    }

    async start() {
        consola.debug("[TestTransport] Starting TEST transport");
    }

    async close() {
        consola.debug("[TestTransport] Closing TEST transport");
    }

    // MCP Server will override this methods
    onmessage(_message: JSONRPCMessage) {
        // MCP Server replaces this during connect; this no-op matches the test-only transport contract.
    }
}

type RPCResponse = JSONRPCResponse | JSONRPCError | JSONRPCNotification;

export async function connect(server: Server) {
    let _recieverCbs: ((message: RPCResponse) => void)[] = [];
    const pending = new Map<number | string, { resolve: (message: RPCResponse) => void; reject: (error: unknown) => void }>();
    let recieverCb = (message: RPCResponse) => {
        _recieverCbs.forEach(cb => cb(message));
        if ((isJSONRPCResponse(message) || isJSONRPCError(message)) && message.id !== undefined) {
            pending.get(message.id)?.resolve(message);
            pending.delete(message.id);
        }
    }
    const transport = new TestTransport(recieverCb);
    await server.connect(transport);
    let _requestId = 1;

    function sendToServer<T extends RPCResponse>(message: Request): Promise<T> {
        const requestId = _requestId++;
        const request: JSONRPCRequest = {
            jsonrpc: "2.0",
            id: requestId,
            ...message,
            params: {
                ...message.params,
                _meta: {
                    progressToken: requestId,
                },
            },
        };
        const promise = new Promise<RPCResponse>((resolve, reject) => pending.set(requestId, { resolve, reject }));
        transport.onmessage?.(request);
        return promise as Promise<T>;
    }

    return {
        sendToServer: sendToServer,
        listTools: async () => {
            const message: JSONRPCResponse = await sendToServer({
                method: ListToolsRequestSchema.shape.method.value,
                params: {},
            });
            return (message as any).result as ListToolsResult;
        },
        onNotification: (notificationCb: (message: JSONRPCMessage) => void) => {
            _recieverCbs.push((message: JSONRPCMessage) => {
                if (isJSONRPCNotification(message)) {
                    notificationCb(message);
                }
            });
        },
        onError: (errorCb: (message: JSONRPCMessage) => void) => {
            _recieverCbs.push((message: JSONRPCMessage) => {
                if (isJSONRPCError(message)) {
                    errorCb(message);
                }
            });
        },
        onProgress: (progressCb: (message: JSONRPCMessage) => void) => {
            _recieverCbs.push((message: JSONRPCMessage) => {
                if (isJSONRPCNotification(message)
                    && ProgressNotificationSchema.safeParse(message).success) {
                    progressCb(message);
                }
            });
        },
        callTool: async (tool: string, params: any = {}) => {
            const message = await sendToServer<JSONRPCResponse>({
                method: CallToolRequestSchema.shape.method.value,
                params: {
                    name: tool,
                    arguments: params,
                },
            });
            return (message as any).result;
        },
        listResources: async () => {
            const message: JSONRPCResponse = await sendToServer({
                method: ListResourcesRequestSchema.shape.method.value,
            });
            return (message as any).result as ListResourcesResult;
        },
        listPrompts: async () => {
            const message: JSONRPCResponse = await sendToServer({
                method: ListPromptsRequestSchema.shape.method.value,
            });
            return (message as any).result as ListPromptsResult;
        },
        getPrompt: async (prompt: string, params: any = {}) => {
            const message = await sendToServer<JSONRPCResponse>({
                method: GetPromptRequestSchema.shape.method.value,
                params: {
                    name: prompt,
                    arguments: params,
                },
            });
            return (message as any).result;
        }
    }
}

export function close(server: Server) {
    server.close();
}