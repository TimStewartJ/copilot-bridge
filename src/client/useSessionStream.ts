import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatMessage, ToolCall } from "./api";

export interface PendingTool {
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  parentToolCallId?: string;
  isSubAgent?: boolean;
}

export type StreamStatus = "idle" | "sending" | "thinking" | "streaming";

export interface StreamState {
  streamingContent: string;
  activeTools: PendingTool[];
  intentText: string;
  toolProgress: string;
  streamStatus: StreamStatus;
  /** Derived from streamStatus for backward compat */
  isStreaming: boolean;
}

export function useSessionStream(
  sessionId: string | null,
  onMessagesUpdated: (msgs: ChatMessage[]) => void,
  onTitleChanged: () => void,
) {
  const mkState = (status: StreamStatus, partial?: Partial<StreamState>): StreamState => ({
    streamingContent: "",
    activeTools: [],
    intentText: "",
    toolProgress: "",
    ...partial,
    streamStatus: status,
    isStreaming: status !== "idle",
  });

  const [streamState, setStreamState] = useState<StreamState>(mkState("idle"));

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);

  // Store callbacks in refs to avoid dependency chain instability
  const onMessagesUpdatedRef = useRef(onMessagesUpdated);
  onMessagesUpdatedRef.current = onMessagesUpdated;
  const onTitleChangedRef = useRef(onTitleChanged);
  onTitleChangedRef.current = onTitleChanged;

  const retryCountRef = useRef(0);

  // Connect to the SSE stream for the current session
  const connectStream = useCallback((sid: string) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStreamState(mkState("sending"));

    fetch(`/api/sessions/${sid}/stream`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          setStreamState((s) => ({ ...s, streamStatus: "idle", isStreaming: false }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedContent = "";
        // Track tool calls for the current turn, preserving start order
        const completedTools: (ToolCall & { _seq: number })[] = [];
        const toolStartSeq = new Map<string, number>();
        let nextSeq = 0;

        const drainTools = (): ToolCall[] | undefined => {
          if (completedTools.length === 0) return undefined;
          completedTools.sort((a, b) => a._seq - b._seq);
          const result: ToolCall[] = completedTools.map(({ _seq, ...tc }) => tc);
          completedTools.length = 0;
          return result;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (sid !== sessionRef.current) return; // stale

              switch (event.type) {
                case "snapshot": {
                  // Catch-up event from EventBus — hydrate current state in one shot
                  if (event.complete) {
                    // Turn already finished — nothing to stream
                    setStreamState((s) => ({ ...s, streamStatus: "idle", isStreaming: false }));
                    break;
                  }
                  accumulatedContent = event.accumulatedContent ?? "";
                  const tools: PendingTool[] = (event.activeTools ?? [])
                    .filter((t: any) => t.name !== "report_intent")
                    .map((t: any) => ({
                      toolCallId: t.toolCallId ?? "",
                      name: t.name ?? "unknown",
                      args: t.args,
                      parentToolCallId: t.parentToolCallId,
                      isSubAgent: t.isSubAgent,
                    }));
                  // Determine status from snapshot content
                  const snapshotStatus: StreamStatus =
                    accumulatedContent || tools.length > 0 ? "streaming" : "thinking";
                  setStreamState({
                    streamingContent: accumulatedContent,
                    activeTools: tools,
                    intentText: event.intentText ?? "",
                    toolProgress: "",
                    streamStatus: snapshotStatus,
                    isStreaming: true,
                  });
                  break;
                }
                case "thinking":
                  setStreamState((s) => ({ ...s, streamStatus: "thinking", isStreaming: true }));
                  break;
                case "intent":
                  setStreamState((s) => ({ ...s, intentText: event.intent ?? "" }));
                  break;
                case "delta":
                  accumulatedContent += event.content ?? "";
                  setStreamState((s) => ({
                    ...s,
                    streamingContent: accumulatedContent,
                    streamStatus: "streaming",
                    isStreaming: true,
                  }));
                  break;
                case "assistant_partial":
                  // Intermediate message — emit with any completed tool calls from this turn
                  if (event.content || completedTools.length > 0) {
                    onMessagesUpdatedRef.current([{
                      role: "assistant",
                      content: event.content ?? "",
                      toolCalls: drainTools(),
                    }]);
                  }
                  accumulatedContent = "";
                  setStreamState((s) => ({ ...s, streamingContent: "" }));
                  break;
                case "tool_start": {
                  const tool: PendingTool = {
                    toolCallId: event.toolCallId ?? "",
                    name: event.name ?? "unknown",
                    args: event.args,
                    parentToolCallId: event.parentToolCallId,
                    isSubAgent: event.isSubAgent,
                  };
                  if (tool.name === "report_intent") break;
                  toolStartSeq.set(tool.toolCallId, nextSeq++);
                  setStreamState((s) => ({
                    ...s,
                    activeTools: [...s.activeTools, tool],
                    toolProgress: "",
                    streamStatus: "streaming",
                    isStreaming: true,
                  }));
                  break;
                }
                case "tool_progress":
                  setStreamState((s) => ({ ...s, toolProgress: event.message ?? "" }));
                  break;
                case "tool_output":
                  setStreamState((s) => ({ ...s, toolProgress: event.content ?? "" }));
                  break;
                case "tool_done": {
                  if (event.name === "report_intent") break;
                  const completed: ToolCall = {
                    toolCallId: event.toolCallId ?? "",
                    name: event.name ?? "unknown",
                    result: event.result,
                    success: event.success,
                    parentToolCallId: event.parentToolCallId,
                    isSubAgent: event.isSubAgent,
                  };
                  setStreamState((s) => {
                    const match = s.activeTools.find((t) => t.toolCallId === event.toolCallId);
                    if (match) {
                      completed.args = match.args;
                      if (match.parentToolCallId) completed.parentToolCallId = match.parentToolCallId;
                      if (match.isSubAgent) completed.isSubAgent = match.isSubAgent;
                    }
                    return {
                      ...s,
                      activeTools: s.activeTools.filter((t) => t.toolCallId !== event.toolCallId),
                      toolProgress: "",
                    };
                  });
                  completedTools.push({ ...completed, _seq: toolStartSeq.get(event.toolCallId) ?? Infinity });
                  break;
                }
                case "title_changed":
                  onTitleChangedRef.current();
                  break;
                case "done":
                  onMessagesUpdatedRef.current([{
                    role: "assistant",
                    content: event.content ?? "",
                    toolCalls: drainTools(),
                  }]);
                  setStreamState(mkState("idle"));
                  onTitleChangedRef.current();
                  // Delayed refreshes to pick up LLM-generated session title
                  setTimeout(() => onTitleChangedRef.current(), 5_000);
                  setTimeout(() => onTitleChangedRef.current(), 12_000);
                  accumulatedContent = "";
                  break;
                case "error":
                  onMessagesUpdatedRef.current([{ role: "assistant", content: `⚠️ Error: ${event.message}` }]);
                  setStreamState(mkState("idle"));
                  break;
                case "idle":
                  setStreamState((s) => ({ ...s, streamStatus: "idle", isStreaming: false }));
                  break;
              }
            } catch { /* skip malformed */ }
          }
        }
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.error("[stream] Error:", err);
        // Retry once on stream failure before giving up
        if (retryCountRef.current < 1 && sid === sessionRef.current) {
          retryCountRef.current++;
          console.warn("[stream] Retrying connection in 1s...");
          setTimeout(() => {
            if (sid === sessionRef.current) connectStream(sid);
          }, 1000);
        } else {
          setStreamState((s) => ({ ...s, streamStatus: "idle", isStreaming: false }));
        }
      });
  }, []); // stable — callbacks accessed via refs

  // Clean up on session change
  useEffect(() => {
    sessionRef.current = sessionId;
    retryCountRef.current = 0;
    setStreamState(mkState("idle"));
    abortRef.current?.abort();
    return () => {
      abortRef.current?.abort();
    };
  }, [sessionId]);

  // Send a message — POST then connect to stream
  const sendMessage = useCallback(async (prompt: string) => {
    if (!sessionId) return;

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, prompt }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      throw new Error(err.error);
    }

    // Connect to stream to watch the work
    retryCountRef.current = 0;
    connectStream(sessionId);
  }, [sessionId, connectStream]);

  // Reconnect to an in-progress stream (e.g., navigating back)
  const reconnect = useCallback((sid: string) => {
    connectStream(sid);
  }, [connectStream]);

  return {
    ...streamState,
    sendMessage,
    reconnect,
  };
}
