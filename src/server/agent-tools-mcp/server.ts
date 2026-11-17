import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../app-context.js";
import { isAdaptedToolHandler } from "./adapter.js";
import { sniffImageMimeFromBase64 } from "../image-mime.js";
import { isRecord } from "../../shared/is-record.js";

export type BridgeToolHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification> & { agentId?: string };
export type BridgeToolHandlerResult = string | CallToolResult | object;
export type BridgeToolScope = "global" | "session" | "both";

export interface BridgeToolDefinition {
  name: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  scope?: BridgeToolScope;
  handler: (
    args: Record<string, unknown>,
    // An MCP BridgeToolHandlerExtra, or the SDK's tool invocation; the adapter reads what it needs.
    extra: unknown,
  ) => BridgeToolHandlerResult | Promise<BridgeToolHandlerResult>;
}

type RegistryScope = "global" | "session";

/** Use the sniffed image type: a wrong MIME makes some model APIs reject the whole request. */
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

/** Typed catalog of Bridge tools, loaded as native tools (bridge-native-tools.ts), no MCP. */
export class BridgeToolsMcpServer {
  private readonly tools = new Map<string, BridgeToolDefinition>();

  constructor(private readonly ctx: AppContext) {}

  registerTool(definition: BridgeToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Bridge tool already registered: ${definition.name}`);
    }
    if (!isAdaptedToolHandler(definition.handler)) {
      throw new Error(
        `Bridge tool ${definition.name} must be built with defineBridgeTool so its arguments are validated`,
      );
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
