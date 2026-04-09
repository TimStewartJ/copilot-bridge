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
    args?: Record<string, unknown>;
    result?: string;
    success?: boolean;
    parentToolCallId?: string;
    isSubAgent?: boolean;
    startedAt?: string;
    completedAt?: string;
  };
}

// Keep backward compat alias — server API consumers still reference this
export type TransformedMessage = TransformedEntry;

/**
 * Transform raw SDK/JSONL events into a chronological list of entries.
 * Pass 1 indexes tool completion results, pass 2 emits entries in event order.
 */
export function transformEventsToMessages(events: any[]): TransformedEntry[] {
  const entries: TransformedEntry[] = [];
  let idx = 0;

  // Pass 1: Index tool completions and sub-agent metadata for enrichment
  const toolCompletes = new Map<string, { success: boolean; content?: string; timestamp?: string }>();
  const subAgentStarts = new Map<string, { agentName: string; agentDisplayName: string }>();
  const subAgentResponses = new Map<string, string>();

  for (const event of events) {
    const data = (event as any).data;
    if (event.type === "tool.execution_complete" && data?.toolCallId) {
      toolCompletes.set(data.toolCallId, { success: data.success, content: data.result?.content, timestamp: (event as any).timestamp });
    } else if (event.type === "subagent.started" && data?.toolCallId) {
      subAgentStarts.set(data.toolCallId, { agentName: data.agentName, agentDisplayName: data.agentDisplayName });
    } else if (event.type === "assistant.message" && data?.parentToolCallId && data?.content) {
      subAgentResponses.set(data.parentToolCallId, data.content);
    }
  }

  // Pass 2: Emit entries chronologically
  for (const event of events) {
    const data = (event as any).data;

    if (event.type === "user.message") {
      const content = data?.content ?? data?.prompt ?? "";
      if (!content.trim() && !data?.attachments?.length) continue;
      const blobAttachments = data.attachments
        ?.filter((a: any) => a.type === "blob" && a.mimeType?.startsWith("image/"))
        ?.map((a: any) => ({ type: "blob" as const, data: a.data, mimeType: a.mimeType, displayName: a.displayName }));
      entries.push({
        id: `entry-${idx++}`,
        type: "message",
        role: "user",
        content,
        timestamp: data.timestamp ?? (event as any).timestamp,
        ...(blobAttachments?.length ? { attachments: blobAttachments } : {}),
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
      if (toolName === "report_intent") continue;
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
          result: isSubAgent ? (subAgentResponses.get(data.toolCallId) ?? complete?.content) : complete?.content,
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
