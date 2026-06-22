import {
  convertMcpCallToolResult,
  type Tool,
  type ToolInvocation,
  type ToolResultObject,
} from "@github/copilot-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeToolDefinition, BridgeToolHandlerResult } from "./agent-tools-mcp/server.js";
import { normalizeToolResult } from "./agent-tools-mcp/server.js";
import { sniffImageMimeFromBase64 } from "./image-mime.js";

export type BridgeNativeTool = Tool<Record<string, unknown>> & {
  /**
   * Copilot runtime external-tool loading policy. The runtime already honors
   * this; Bridge patches the SDK serializer so the field reaches the host.
   */
  defer?: "never";
};

const SDK_TOOL_RESULT_TYPES = new Set([
  "success",
  "failure",
  "rejected",
  "denied",
  "timeout",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

function isSdkToolResultObject(result: unknown): result is ToolResultObject {
  return isRecord(result)
    && typeof result.textResultForLlm === "string"
    && typeof result.resultType === "string"
    && SDK_TOOL_RESULT_TYPES.has(result.resultType);
}

function convertCallToolResult(callResult: CallToolResult): ToolResultObject {
  const converted = convertMcpCallToolResult(callResult as Parameters<typeof convertMcpCallToolResult>[0]);
  if (converted.resultType !== "success" && !converted.error) {
    return { ...converted, error: converted.textResultForLlm };
  }
  return converted;
}

/**
 * Relabel image binaries whose declared MIME type contradicts their magic bytes.
 * Covers SDK-shaped results that bypass `normalizeToolResult`, so a mismatched
 * image can never reach the model through a bridge-native tool.
 */
function correctSdkBinaryImageMimes(result: ToolResultObject): ToolResultObject {
  const binary = result.binaryResultsForLlm;
  if (!binary || binary.length === 0) return result;
  let changed = false;
  const next = binary.map((item) => {
    if (item.type === "image" && typeof item.data === "string") {
      const sniffed = sniffImageMimeFromBase64(item.data);
      if (sniffed && sniffed !== item.mimeType) {
        changed = true;
        return { ...item, mimeType: sniffed };
      }
    }
    return item;
  });
  return changed ? { ...result, binaryResultsForLlm: next } : result;
}

export function convertBridgeToolResultToSdk(result: BridgeToolHandlerResult): ToolResultObject {
  if (isRecord(result) && Array.isArray(result.content)) {
    return convertCallToolResult(normalizeToolResult(result));
  }
  if (isSdkToolResultObject(result)) return correctSdkBinaryImageMimes(result);
  return convertCallToolResult(normalizeToolResult(result));
}

function createSdkInvocationExtra(invocation: ToolInvocation): Record<string, unknown> {
  return {
    ...invocation,
    requestId: invocation.toolCallId,
    sessionId: invocation.sessionId,
  };
}

export function createNativeBridgeTools(
  definitions: readonly BridgeToolDefinition[],
): BridgeNativeTool[] {
  return definitions.map((definition): BridgeNativeTool => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema ?? { type: "object", properties: {} },
    defer: "never",
    skipPermission: true,
    handler: async (args, invocation) => convertBridgeToolResultToSdk(
      await definition.handler(normalizeArgs(args), createSdkInvocationExtra(invocation)),
    ),
  }));
}
