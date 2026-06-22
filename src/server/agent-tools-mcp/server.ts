import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { dirname } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../app-context.js";
import { BRIDGE_TOOLS_MCP_SERVER_NAME, isWindowsNamedPipeEndpoint } from "./endpoint.js";
import { sniffImageMimeFromBase64 } from "../image-mime.js";

export type BridgeToolHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type BridgeToolHandlerResult = string | CallToolResult | object;
export type BridgeToolScope = "global" | "session" | "both";

export interface BridgeToolDefinition {
  name: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  scope?: BridgeToolScope;
  handler: (
    args: Record<string, unknown>,
    extra: any,
  ) => BridgeToolHandlerResult | Promise<BridgeToolHandlerResult>;
}

export interface BridgeToolsMcpServerOptions {
  onError?: (error: Error) => void;
}

type ActiveConnection = {
  server: Server;
  socket: Socket;
};

type ListenerScope = "global" | "session";

type ActiveListener = {
  key: string;
  endpoint: string;
  scope: ListenerScope;
  sessionId?: string;
  server: NetServer;
  activeConnections: Set<ActiveConnection>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Relabel image content items whose declared MIME type disagrees with their
 * actual magic bytes. A mismatch makes some model APIs reject the whole request,
 * so the detected type wins for any image we recognize.
 */
function correctImageContentMimes(content: CallToolResult["content"]): CallToolResult["content"] {
  return content.map((item) =>
    item.type === "image" && typeof item.data === "string"
      ? { ...item, mimeType: sniffImageMimeFromBase64(item.data) ?? item.mimeType }
      : item,
  );
}

export function normalizeToolResult(result: BridgeToolHandlerResult): CallToolResult {
  if (isRecord(result) && Array.isArray(result.content)) {
    const callResult = result as CallToolResult;
    return { ...callResult, content: correctImageContentMimes(callResult.content) };
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  if (isRecord(result) && typeof result.resultType === "string" && result.resultType !== "success") {
    const text = typeof result.textResultForLlm === "string"
      ? result.textResultForLlm
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result, null, 2);
    return { isError: true, content: [{ type: "text", text }] };
  }
  if (isRecord(result) && typeof result.textResultForLlm === "string") {
    return { content: [{ type: "text", text: result.textResultForLlm }] };
  }
  if (
    isRecord(result) &&
    result.type === "image" &&
    typeof result.data === "string" &&
    typeof result.mimeType === "string"
  ) {
    const mimeType = sniffImageMimeFromBase64(result.data) ?? result.mimeType;
    return { content: [{ type: "image", data: result.data, mimeType }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function removeStalePosixSocket(endpoint: string): void {
  if (isWindowsNamedPipeEndpoint(endpoint)) return;
  mkdirSync(dirname(endpoint), { recursive: true });
  try {
    const stat = lstatSync(endpoint);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to remove non-socket Bridge MCP endpoint: ${endpoint}`);
    }
    rmSync(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class BridgeToolsMcpServer {
  private readonly tools = new Map<string, BridgeToolDefinition>();
  private readonly listeners = new Map<string, ActiveListener>();

  constructor(
    private readonly ctx: AppContext,
    private readonly options: BridgeToolsMcpServerOptions = {},
  ) {}

  registerTool(definition: BridgeToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Bridge MCP tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition);
  }

  getToolDefinitions(scope: ListenerScope | "all" = "global"): BridgeToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => scope === "all" || this.isToolVisible(tool, scope));
  }

  getToolNames(scope: ListenerScope = "global"): string[] {
    return this.getToolDefinitions(scope)
      .map((tool) => tool.name);
  }

  async listen(endpoint: string): Promise<void> {
    await this.listenWithContext({ key: "global", endpoint, scope: "global" });
  }

  async listenForSession(sessionId: string, endpoint: string): Promise<void> {
    if (!sessionId.trim()) throw new Error("sessionId is required for session-scoped Bridge MCP endpoint");
    await this.listenWithContext({
      key: `session:${sessionId}`,
      endpoint,
      scope: "session",
      sessionId,
    });
  }

  async closeSessionEndpoint(sessionId: string): Promise<void> {
    await this.closeListener(`session:${sessionId}`);
  }

  async close(): Promise<void> {
    await Promise.all([...this.listeners.keys()].map((key) => this.closeListener(key)));
  }

  private async listenWithContext(params: {
    key: string;
    endpoint: string;
    scope: ListenerScope;
    sessionId?: string;
  }): Promise<void> {
    const existing = this.listeners.get(params.key);
    if (existing) {
      if (existing.endpoint !== params.endpoint || existing.scope !== params.scope || existing.sessionId !== params.sessionId) {
        throw new Error(`Bridge tools MCP listener ${params.key} already exists with different settings`);
      }
      return;
    }

    const { endpoint } = params;
    removeStalePosixSocket(endpoint);

    const server = createServer((socket) => {
      const listener = this.listeners.get(params.key);
      if (!listener) {
        socket.destroy();
        return;
      }
      this.handleSocket(socket, listener);
    });
    const listener: ActiveListener = {
      ...params,
      server,
      activeConnections: new Set(),
    };
    this.listeners.set(params.key, listener);

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(endpoint);
      });
    } catch (error) {
      this.listeners.delete(params.key);
      server.close();
      throw error;
    }
  }

  private async closeListener(key: string): Promise<void> {
    const listener = this.listeners.get(key);
    if (!listener) return;
    this.listeners.delete(key);
    const closeServerPromise = closeNetServer(listener.server);

    await Promise.all([...listener.activeConnections].map(async (connection) => {
      await connection.server.close();
      connection.socket.destroy();
    }));
    listener.activeConnections.clear();

    await closeServerPromise;

    if (!isWindowsNamedPipeEndpoint(listener.endpoint)) {
      rmSync(listener.endpoint, { force: true });
    }
  }

  private handleSocket(socket: Socket, listener: ActiveListener): void {
    const protocolServer = this.createProtocolServer(listener);
    const connection: ActiveConnection = { server: protocolServer, socket };
    listener.activeConnections.add(connection);
    let cleanedUp = false;

    const cleanupConnection = (): boolean => {
      if (cleanedUp) return false;
      cleanedUp = true;
      listener.activeConnections.delete(connection);
      socket.destroy();
      return true;
    };

    protocolServer.onclose = () => {
      cleanupConnection();
    };
    protocolServer.onerror = (error) => {
      this.options.onError?.(error);
    };
    socket.on("error", (error) => {
      this.options.onError?.(error);
    });
    socket.once("close", () => {
      if (!cleanupConnection()) return;
      protocolServer.close().catch((error: unknown) => {
        this.options.onError?.(toError(error));
      });
    });

    const transport = new StdioServerTransport(socket, socket);
    protocolServer.connect(transport).catch((error: unknown) => {
      cleanupConnection();
      this.options.onError?.(toError(error));
    });
  }

  private createProtocolServer(listener: Pick<ActiveListener, "scope" | "sessionId">): Server {
    void this.ctx;
    const server = new Server(
      { name: BRIDGE_TOOLS_MCP_SERVER_NAME, version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...this.tools.values()]
        .filter((tool) => this.isToolVisible(tool, listener.scope))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = this.tools.get(request.params.name);
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown Bridge tool: ${request.params.name}`);
      }
      if (!this.isToolVisible(tool, listener.scope)) {
        throw new McpError(ErrorCode.InvalidParams, `Bridge tool is not available on this endpoint: ${request.params.name}`);
      }

      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      const scopedExtra = listener.sessionId ? { ...extra, sessionId: listener.sessionId } : extra;
      return normalizeToolResult(await tool.handler(args, scopedExtra));
    });

    return server;
  }

  private isToolVisible(tool: BridgeToolDefinition, listenerScope: ListenerScope): boolean {
    const toolScope = tool.scope ?? "global";
    return toolScope === "both" || toolScope === listenerScope;
  }
}
