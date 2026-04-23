import { getToolExecutionDisplayText } from "./tool-results.js";

// Shared event→entry transform logic
// Produces a flat chronological list of text messages and tool calls.
// Used by both getSessionMessages (SDK path) and readMessagesFromDisk (fast path)

export interface TransformedEntry {
  id: string;
  type: "message" | "tool";
  // Message fields (when type === "message")
  role?: string;
  content?: string;
  timestamp?: string;
  attachments?: Array<{ type: "blob"; data: string; mimeType: string; displayName?: string }>;
  // Tool fields (when type === "tool")
  toolCall?: {
    toolCallId: string;
    name: string;
    args?: unknown;
    result?: string;
    progressText?: string;
    success?: boolean;
    parentToolCallId?: string;
    isSubAgent?: boolean;
    startedAt?: string;
    completedAt?: string;
  };
}

// Keep backward compat alias — server API consumers still reference this
export type TransformedMessage = TransformedEntry;

function isTurnTerminalEvent(event: any): boolean {
  return event.type === "session.shutdown"
    || event.type === "session.idle"
    || event.type === "session.error";
}

function getRenameTargetSessionId(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).sessionId;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isHiddenTool(toolName: string, args: unknown, sessionId?: string): boolean {
  if (toolName === "report_intent") return true;
  if (toolName !== "session_rename") return false;
  const targetSessionId = getRenameTargetSessionId(args);
  return targetSessionId === undefined || (sessionId !== undefined && targetSessionId === sessionId);
}

function isVisibleMessageEvent(event: any, sessionId?: string): boolean {
  const data = event?.data;

  if (event.type === "user.message") {
    return Boolean((data?.content ?? data?.prompt ?? "").trim() || data?.attachments?.length);
  }

  if (event.type === "assistant.message") {
    return !data?.parentToolCallId && Boolean((data?.content ?? "").trim());
  }

  if (event.type === "tool.execution_start") {
    const toolName = data?.toolName ?? data?.name ?? "unknown";
    return Boolean(data?.toolCallId) && !isHiddenTool(toolName, data?.arguments, sessionId);
  }

  return false;
}

export function getVisibleEventTimestamp(event: any, sessionId?: string): string | undefined {
  if (!isVisibleMessageEvent(event, sessionId)) return undefined;
  return event?.data?.timestamp ?? event?.timestamp;
}

export function getLastVisibleActivityAt(events: any[], sessionId?: string): string | undefined {
  const visibleToolCallIds = new Set<string>();
  let lastVisibleActivityAt: string | undefined;

  for (const event of events) {
    const timestamp = getVisibleEventTimestamp(event, sessionId);
    if (timestamp) {
      lastVisibleActivityAt = timestamp;
      if (event.type === "tool.execution_start" && event?.data?.toolCallId) {
        visibleToolCallIds.add(event.data.toolCallId);
      }
      continue;
    }

    if (event.type === "tool.execution_complete" && event?.data?.toolCallId && visibleToolCallIds.has(event.data.toolCallId)) {
      const completedAt = event?.timestamp;
      if (completedAt) lastVisibleActivityAt = completedAt;
    }
  }
  return lastVisibleActivityAt;
}

/**
 * Transform raw SDK/JSONL events into a chronological list of entries.
 * Pass 1 indexes tool completion results, pass 2 emits entries in event order.
 */
export function transformEventsToMessages(events: any[], sessionId?: string): TransformedEntry[] {
  const entries: TransformedEntry[] = [];
  let idx = 0;

  // Pass 1: Index tool completions and sub-agent metadata for enrichment
  const toolCompletes = new Map<string, { success: boolean; result?: string; timestamp?: string }>();
  const toolProgress = new Map<string, string>();
  const openToolCallIds = new Set<string>();
  const subAgentStarts = new Map<string, { agentName: string; agentDisplayName: string }>();
  const subAgentResponses = new Map<string, string>();

  for (const event of events) {
    const data = (event as any).data;
    if (event.type === "tool.execution_start" && data?.toolCallId) {
      openToolCallIds.add(data.toolCallId);
    } else if (event.type === "tool.execution_complete" && data?.toolCallId) {
      toolCompletes.set(data.toolCallId, {
        success: data.success,
        result: getToolExecutionDisplayText(data),
        timestamp: (event as any).timestamp,
      });
      openToolCallIds.delete(data.toolCallId);
    } else if ((event.type === "tool.execution_progress" || event.type === "tool.execution_partial_result") && data?.toolCallId) {
      const nextText = event.type === "tool.execution_progress"
        ? data.progressMessage
        : data.partialOutput;
      if (typeof nextText === "string" && nextText.trim()) {
        toolProgress.set(data.toolCallId, nextText);
      }
    } else if (event.type === "subagent.started" && data?.toolCallId) {
      subAgentStarts.set(data.toolCallId, { agentName: data.agentName, agentDisplayName: data.agentDisplayName });
    } else if (event.type === "assistant.message" && data?.parentToolCallId && data?.content) {
      subAgentResponses.set(data.parentToolCallId, data.content);
    } else if (isTurnTerminalEvent(event)) {
      for (const toolCallId of openToolCallIds) {
        toolCompletes.set(toolCallId, {
          success: false,
          result: subAgentResponses.get(toolCallId) ?? toolProgress.get(toolCallId),
          timestamp: (event as any).timestamp,
        });
      }
      openToolCallIds.clear();
    }
  }

  // Pass 2: Emit entries chronologically
  for (const event of events) {
    const data = (event as any).data;

    if (event.type === "user.message") {
      const content = data?.content ?? data?.prompt ?? "";
      if (!content.trim() && !data?.attachments?.length) continue;
      const blobAttachments = data.attachments
        ?.filter((a: any) => a.type === "blob" && a.mimeType)
        ?.map((a: any) => ({ type: "blob" as const, data: a.data, mimeType: a.mimeType, displayName: a.displayName }));
      const fileAttachments = data.attachments
        ?.filter((a: any) => a.type === "file" && a.path)
        ?.map((a: any) => ({ type: "file" as const, path: a.path, displayName: a.displayName ?? a.path.split("/").pop() }));
      const allAttachments = [...(blobAttachments ?? []), ...(fileAttachments ?? [])];
      entries.push({
        id: `entry-${idx++}`,
        type: "message",
        role: "user",
        content,
        timestamp: data.timestamp ?? (event as any).timestamp,
        ...(allAttachments.length ? { attachments: allAttachments } : {}),
      });
    } else if (event.type === "assistant.message") {
      if (data?.parentToolCallId) continue; // sub-agent response text, not a top-level message
      const content = data?.content ?? "";
      if (content.trim()) {
        entries.push({
          id: `entry-${idx++}`,
          type: "message",
          role: "assistant",
          content,
          timestamp: data.timestamp ?? (event as any).timestamp,
        });
      }
    } else if (event.type === "tool.execution_start") {
      if (!data?.toolCallId) continue;
      const toolName = data.toolName ?? data.name ?? "unknown";
      if (isHiddenTool(toolName, data.arguments, sessionId)) continue;
      const subAgent = subAgentStarts.get(data.toolCallId);
      const complete = toolCompletes.get(data.toolCallId);
      const isSubAgent = !!subAgent;
      entries.push({
        id: `entry-${idx++}`,
        type: "tool",
        toolCall: {
          toolCallId: data.toolCallId,
          name: isSubAgent ? `🤖 ${subAgent!.agentDisplayName ?? subAgent!.agentName ?? "agent"}` : toolName,
          args: data.arguments,
          result: isSubAgent && complete?.success !== false
            ? (subAgentResponses.get(data.toolCallId) ?? complete?.result)
            : complete?.result,
          progressText: toolProgress.get(data.toolCallId),
          success: complete?.success,
          parentToolCallId: data.parentToolCallId,
          isSubAgent: isSubAgent || undefined,
          startedAt: (event as any).timestamp,
          completedAt: complete?.timestamp,
        },
      });
    }
  }

  return entries;
}
