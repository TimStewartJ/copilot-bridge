import type { ChatEntry, McpServerStatus, SessionToolReadinessSnapshot, ToolCall } from "../api";
import { classifyToolFailure } from "../../shared/tool-failure";

export const MCP_CONNECTION_GUIDANCE = "Tool permissions are separate from connection status.";

/**
 * Whether a session's status line reports a problem, for a mark on the control that opens it where
 * the line itself is folded away. Loading and connecting are not problems; they settle by themselves.
 */
export function statusLineHasProblem({ servers, statusState, toolReadiness, toolFailureCount }: {
  servers: McpServerStatus[];
  statusState: "loading" | "ready" | "error" | "stale";
  toolReadiness?: SessionToolReadinessSnapshot;
  toolFailureCount: number;
}): boolean {
  return statusState === "error"
    || toolReadiness?.state === "failed"
    || toolFailureCount > 0
    || servers.some((server) => server.status === "failed" || server.status === "needs-auth");
}

export function mcpObservationTitle(server: McpServerStatus): string {
  return `${server.observedAt ?? "Unknown time"}; ${server.provenance ?? "unknown source"}; session ${server.sessionId ?? "unknown"}`;
}

export function mcpObservationLabel(server: McpServerStatus, now = Date.now()): string {
  const observedAt = server.observedAt ? Date.parse(server.observedAt) : NaN;
  if (!Number.isFinite(observedAt)) return "Observation time unavailable";
  const stale = now - observedAt >= 30_000 || server.provenance === "replay-event";
  return `${stale ? "Last checked (may be stale)" : "Checked"}: ${new Date(observedAt).toLocaleTimeString()}`;
}

export function recentToolFailures(entries: ChatEntry[] = []) {
  const latest = new Map<string, ToolCall>();
  for (const entry of entries) {
    if (entry.type === "tool" && !entry.toolCall.isSubAgent && entry.toolCall.success !== undefined) {
      latest.delete(entry.toolCall.name);
      latest.set(entry.toolCall.name, entry.toolCall);
    }
  }
  return [...latest.values()].filter((tool) => tool.success === false).slice(-3).map((tool) => ({
    name: tool.name,
    failure: classifyToolFailure(tool.result),
  }));
}
