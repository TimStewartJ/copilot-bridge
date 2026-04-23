import type { ToolCall } from "../api";

export type ToolCallStatus = "running" | "done" | "failed";

export function getToolCallStatus(toolCall: Pick<ToolCall, "success" | "completedAt" | "result">): ToolCallStatus {
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
