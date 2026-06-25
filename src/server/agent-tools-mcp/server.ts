import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../app-context.js";
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

type RegistryScope = "global" | "session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * In-process registry of public Bridge tools.
 *
 * The Copilot backend loads these definitions directly as native first-class
 * tools (see `bridge-native-tools.ts`), so the Bridge no longer runs an MCP
 * socket/stdio transport for them. This class is purely a typed catalog:
 * `registerAllBridgeTools` populates it and SessionManager reads the
 * definitions to build the native tool surface.
 */
export class BridgeToolsMcpServer {
  private readonly tools = new Map<string, BridgeToolDefinition>();

  constructor(private readonly ctx: AppContext) {}

  registerTool(definition: BridgeToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Bridge tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition);
  }

  getToolDefinitions(scope: RegistryScope | "all" = "global"): BridgeToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => scope === "all" || this.isToolVisible(tool, scope));
  }

  getToolNames(scope: RegistryScope = "global"): string[] {
    return this.getToolDefinitions(scope)
      .map((tool) => tool.name);
  }

  private isToolVisible(tool: BridgeToolDefinition, scope: RegistryScope): boolean {
    const toolScope = tool.scope ?? "global";
    return toolScope === "both" || toolScope === scope;
  }
}
