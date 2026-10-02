import type { ToolCall } from "../api";

export type ToolCallStatus = "running" | "done" | "failed";

/**
 * Where a call stands. A call that launched an agent stands where the agent does: a background
 * agent's launching call returns the moment the agent starts, long before its work is done.
 */
export function getToolCallStatus(
  toolCall: Pick<ToolCall, "success" | "completedAt" | "result" | "agent">,
): ToolCallStatus {
  if (toolCall.agent) {
    if (toolCall.agent.status === "running") return "running";
    if (toolCall.agent.status === "failed" || toolCall.success === false) return "failed";
    return "done";
  }
  return getOwnToolCallStatus(toolCall);
}

/** Where the call itself stands, whatever became of an agent it launched. */
export function getOwnToolCallStatus(
  toolCall: Pick<ToolCall, "success" | "completedAt" | "result">,
): ToolCallStatus {
  if (toolCall.success === false) return "failed";
  if (toolCall.completedAt || toolCall.success === true) return "done";
  return "running";
}

export function getToolCallStatusLabel(status: ToolCallStatus): string {
  switch (status) {
    case "failed":
      return "Failed";
    case "done":
      return "Done";
    default:
      return "Running";
  }
}
