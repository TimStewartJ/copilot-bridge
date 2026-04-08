// Shared event→message transform logic
// Used by both getSessionMessages (SDK path) and readMessagesFromDisk (fast path)

export interface TransformedMessage {
  id: string;
  role: string;
  content: string;
  timestamp?: string;
  attachments?: Array<{ type: "blob"; data: string; mimeType: string; displayName?: string }>;
  toolCalls?: Array<{
    toolCallId: string;
    name: string;
    args?: Record<string, unknown>;
    result?: string;
    success?: boolean;
    parentToolCallId?: string;
    isSubAgent?: boolean;
    startedAt?: string;
    completedAt?: string;
  }>;
}

/**
 * Transform raw SDK/JSONL events into UI-ready messages.
 * Two-pass: first indexes tool events, then builds message list.
 */
export function transformEventsToMessages(events: any[]): TransformedMessage[] {
  const messages: TransformedMessage[] = [];
  let msgIndex = 0;

  // Pass 1: Index tool events by toolCallId for fast lookup
  const toolStarts = new Map<string, { toolName: string; arguments?: Record<string, unknown>; parentToolCallId?: string; timestamp?: string }>();
  const toolCompletes = new Map<string, { success: boolean; content?: string; timestamp?: string }>();
  const subAgentStarts = new Map<string, { agentName: string; agentDisplayName: string }>();
  const subAgentResponses = new Map<string, string>();

  for (const event of events) {
    const data = (event as any).data;
    if (event.type === "tool.execution_start" && data?.toolCallId) {
      toolStarts.set(data.toolCallId, { toolName: data.toolName, arguments: data.arguments, parentToolCallId: data.parentToolCallId, timestamp: (event as any).timestamp });
    } else if (event.type === "tool.execution_complete" && data?.toolCallId) {
      toolCompletes.set(data.toolCallId, { success: data.success, content: data.result?.content, timestamp: (event as any).timestamp });
    } else if (event.type === "subagent.started" && data?.toolCallId) {
      subAgentStarts.set(data.toolCallId, { agentName: data.agentName, agentDisplayName: data.agentDisplayName });
    } else if (event.type === "assistant.message" && data?.parentToolCallId && data?.content) {
      subAgentResponses.set(data.parentToolCallId, data.content);
    }
  }

  // Pass 2: Build messages from user.message and assistant.message events
  for (const event of events) {
    if (event.type === "user.message") {
      const data = event.data as any;
      const content = data.content ?? data.prompt ?? "";
      if (content.trim() || data.attachments?.length) {
        const blobAttachments = data.attachments
          ?.filter((a: any) => a.type === "blob" && a.mimeType?.startsWith("image/"))
          ?.map((a: any) => ({ type: "blob" as const, data: a.data, mimeType: a.mimeType, displayName: a.displayName }));
        messages.push({
          id: `msg-${msgIndex++}`,
          role: "user",
          content,
          timestamp: data.timestamp ?? (event as any).timestamp,
          ...(blobAttachments?.length ? { attachments: blobAttachments } : {}),
        });
      }
    } else if (event.type === "assistant.message") {
      const data = (event as any).data;
      if (data?.parentToolCallId) continue;
      const content = data.content ?? "";

      let toolCalls: TransformedMessage["toolCalls"];
      if (data.toolRequests?.length) {
        toolCalls = data.toolRequests
          .filter((tr: any) => tr.name !== "report_intent")
          .map((tr: any) => {
            const start = toolStarts.get(tr.toolCallId);
            const complete = toolCompletes.get(tr.toolCallId);
            const subAgent = subAgentStarts.get(tr.toolCallId);
            if (subAgent) {
              return {
                toolCallId: tr.toolCallId,
                name: `🤖 ${subAgent.agentDisplayName ?? subAgent.agentName ?? "agent"}`,
                isSubAgent: true,
                result: subAgentResponses.get(tr.toolCallId) ?? complete?.content,
                success: complete?.success,
                startedAt: start?.timestamp,
                completedAt: complete?.timestamp,
              };
            }
            return {
              toolCallId: tr.toolCallId,
              name: tr.name,
              args: start?.arguments ?? tr.arguments,
              result: complete?.content,
              success: complete?.success,
              parentToolCallId: start?.parentToolCallId,
              startedAt: start?.timestamp,
              completedAt: complete?.timestamp,
            };
          });

        // Inject child tool calls for sub-agent parents
        const injected: typeof toolCalls = [];
        for (const tc of toolCalls!) {
          injected.push(tc);
          if (tc.isSubAgent) {
            for (const [childId, s] of toolStarts.entries()) {
              if (s.parentToolCallId === tc.toolCallId && s.toolName !== "report_intent") {
                const childComplete = toolCompletes.get(childId);
                injected.push({
                  toolCallId: childId,
                  name: s.toolName,
                  args: s.arguments,
                  result: childComplete?.content,
                  success: childComplete?.success,
                  parentToolCallId: tc.toolCallId,
                  startedAt: s.timestamp,
                  completedAt: childComplete?.timestamp,
                });
              }
            }
          }
        }
        toolCalls = injected;
        if (toolCalls.length === 0) toolCalls = undefined;
      }

      if (content.trim() || toolCalls) {
        messages.push({
          id: `msg-${msgIndex++}`,
          role: "assistant",
          content,
          timestamp: data.timestamp ?? (event as any).timestamp,
          toolCalls,
        });
      }
    }
  }

  return messages;
}
