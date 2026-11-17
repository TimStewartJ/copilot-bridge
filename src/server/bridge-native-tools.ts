import {
  convertMcpCallToolResult,
  type Tool,
  type ToolInvocation,
  type ToolResultObject,
} from "@github/copilot-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeToolDefinition, BridgeToolHandlerResult } from "./agent-tools-mcp/server.js";
import { normalizeToolResult } from "./agent-tools-mcp/server.js";
import { isRecord } from "../shared/is-record.js";
import { sniffImageMimeFromBase64 } from "./image-mime.js";

export type BridgeNativeTool = Tool<Record<string, unknown>> & {
  /** "auto" lets the runtime load the tool on demand through its tool search. */
  defer?: "auto" | "never";
};

/** Rarely used tools, loaded via tool search; tools the prompt requires (agent_stop) stay out. */
export const DEFERRED_BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "action_add", "action_remove", "action_update",
  "checklist_add", "checklist_list", "checklist_remove", "checklist_update",
  "docs_db_add", "docs_db_create", "docs_db_delete", "docs_delete",
  "docs_snapshot_create", "docs_snapshot_list", "docs_snapshot_restore",
  "git_worktree_release",
  "self_restart", "self_update", "staging_cleanup",
  "session_archive", "session_rename", "session_send", "session_set_workspace", "session_start",
  "tag_create", "tag_delete", "tag_list", "tag_update",
  "task_create", "task_group_create", "task_group_delete", "task_group_list", "task_group_update",
  "task_link_work_item", "task_page_publish", "task_unlink_work_item",
  "trigger_delete", "trigger_run",
]);

/** Read-only Bridge tools the runtime may repeat if a crash lost the outcome (SDK `idempotent`). */
export const IDEMPOTENT_BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "action_list", "bridge_overview", "calendar_list", "checklist_list",
  "docs_db_query", "docs_db_schema", "docs_list", "docs_read", "docs_search", "docs_snapshot_list",
  "find", "list_models", "list_sessions", "management_job_status", "management_job_wait",
  "read_bridge", "read_conversation", "read_session", "read_source",
  "tag_list", "task_get_info", "task_group_list", "task_history_list", "task_list", "trigger_list",
]);

const SDK_TOOL_RESULT_TYPES = new Set([
  "success",
  "failure",
  "rejected",
  "denied",
  "timeout",
]);

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

/** Fix image MIME from magic bytes for SDK-shaped results that skip normalizeToolResult. */
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
  options: { deferRarelyUsed?: boolean } = {},
): BridgeNativeTool[] {
  return definitions.map((definition): BridgeNativeTool => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema ?? { type: "object", properties: {} },
    defer: options.deferRarelyUsed && DEFERRED_BRIDGE_TOOL_NAMES.has(definition.name) ? "auto" : "never",
    ...(IDEMPOTENT_BRIDGE_TOOL_NAMES.has(definition.name) ? { idempotent: true } : {}),
    skipPermission: true,
    handler: async (args, invocation) => convertBridgeToolResultToSdk(
      await definition.handler(normalizeArgs(args), createSdkInvocationExtra(invocation)),
    ),
  }));
}
