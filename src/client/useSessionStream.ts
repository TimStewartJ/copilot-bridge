import { useState, useEffect, useRef, useCallback } from "react";
import type { BlobAttachment, ChatEntry, McpServerStatus, ToolArgs, ToolCall } from "./api";
import { API_BASE } from "./api";

export interface PendingTool {
  toolCallId: string;
  name: string;
  args?: ToolArgs;
  parentToolCallId?: string;
  isSubAgent?: boolean;
  startedAt?: string;
}

export type StreamStatus = "idle" | "sending" | "thinking" | "streaming";

export interface StreamState {
  streamingContent: string;
  activeTools: PendingTool[];
  intentText: string;
  toolProgress: string;
  streamStatus: StreamStatus;
  isStreaming: boolean;
  mcpServers: McpServerStatus[];
}

export function useSessionStream(
  sessionId: string | null,
  onEntriesAppended: (entries: ChatEntry[]) => void,
  onTitleChanged: () => void,
) {
  const mkState = (status: StreamStatus, partial?: Partial<StreamState>): StreamState => ({
    streamingContent: "",
    activeTools: [],
    completedStreamTools: [],
    intentText: "",
    toolProgress: "",
    mcpServers: [],
    ...partial,
    streamStatus: status,
    isStreaming: status !== "idle",
  });

  const [streamState, setStreamState] = useState<StreamState>(mkState("idle"));

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);

  const onEntriesRef = useRef(onEntriesAppended);
  onEntriesRef.current = onEntriesAppended;
  const onTitleChangedRef = useRef(onTitleChanged);
  onTitleChangedRef.current = onTitleChanged;

  const retryCountRef = useRef(0);

  const connectStream = useCallback((sid: string) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStreamState(mkState("sending"));

    fetch(`${API_BASE}/api/sessions/${sid}/stream`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          setStreamState((s) => ({ ...s, streamStatus: "idle", isStreaming: false }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedContent = "";

        // Plain Map for synchronous metadata access on tool_done
        const activeToolMeta = new Map<string, PendingTool>();

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
                  if (event.complete) {
                    setStreamState((s) => ({ ...s, streamStatus: "idle", isStreaming: false }));
                    break;
                  }
                  if (event.pendingPrompt) {
                    onEntriesRef.current([{ role: "user", content: event.pendingPrompt }]);
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
                  activeToolMeta.clear();
                  for (const t of tools) activeToolMeta.set(t.toolCallId, t);
                  setStreamState((prev) => ({
                    ...prev,
                    streamingContent: accumulatedContent,
                    activeTools: tools,
                    intentText: event.intentText ?? "",
                    toolProgress: "",
                    mcpServers: event.mcpServers ?? prev.mcpServers,
                    streamStatus: accumulatedContent || tools.length > 0 ? "streaming" : "thinking",
                    isStreaming: true,
                  }));
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
                  if (event.content) {
                    onEntriesRef.current([{ role: "assistant", content: event.content }]);
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
                    startedAt: event.timestamp,
                  };
                  if (tool.name === "report_intent") break;
                  activeToolMeta.set(tool.toolCallId, tool);
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
                case "tool_update": {
                  const meta = activeToolMeta.get(event.toolCallId as string);
                  if (meta) {
                    meta.name = event.name ?? meta.name;
                    meta.isSubAgent = (event.isSubAgent as boolean) ?? meta.isSubAgent;
                  }
                  setStreamState((s) => ({
                    ...s,
                    activeTools: s.activeTools.map((t) =>
                      t.toolCallId === event.toolCallId
                        ? { ...t, name: event.name ?? t.name, isSubAgent: event.isSubAgent ?? t.isSubAgent }
                        : t,
                    ),
                  }));
                  break;
                }
                case "tool_done": {
                  if (event.name === "report_intent") break;
                  const meta = activeToolMeta.get(event.toolCallId);
                  activeToolMeta.delete(event.toolCallId);
                  const tc: ToolCall = {
                    toolCallId: event.toolCallId ?? "",
                    name: meta?.name ?? event.name ?? "unknown",
                    args: meta?.args,
                    result: event.result,
                    success: event.success,
                    parentToolCallId: meta?.parentToolCallId ?? event.parentToolCallId,
                    isSubAgent: meta?.isSubAgent ?? event.isSubAgent,
                    startedAt: meta?.startedAt,
                    completedAt: event.timestamp,
                  };
                  onEntriesRef.current([{ type: "tool", toolCall: tc }]);
                  setStreamState((s) => ({
                    ...s,
                    activeTools: s.activeTools.filter((t) => t.toolCallId !== event.toolCallId),
                    toolProgress: "",
                  }));
                  break;
                }
                case "title_changed":
                  onTitleChangedRef.current();
                  break;
                case "done":
                  if (event.content) {
                    onEntriesRef.current([{ role: "assistant", content: event.content }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                  onTitleChangedRef.current();
                  setTimeout(() => onTitleChangedRef.current(), 5_000);
                  setTimeout(() => onTitleChangedRef.current(), 12_000);
                  accumulatedContent = "";
                  break;
                case "aborted": {
                  const text = event.content || accumulatedContent;
                  if (text) {
                    onEntriesRef.current([{ role: "assistant", content: text + "\n\n*(stopped)*" }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                  accumulatedContent = "";
                  break;
                }
                case "error":
                  onEntriesRef.current([{ role: "assistant", content: `⚠️ Error: ${event.message}` }]);
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                  break;
                case "mcp_status":
                  setStreamState((s) => ({ ...s, mcpServers: event.servers ?? [] }));
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

  useEffect(() => {
    sessionRef.current = sessionId;
    retryCountRef.current = 0;
    setStreamState(mkState("idle"));
    abortRef.current?.abort();
    return () => { abortRef.current?.abort(); };
  }, [sessionId]);

  const sendMessage = useCallback(async (prompt: string, attachments?: BlobAttachment[]) => {
    if (!sessionId) return;
    setStreamState((s) => mkState("sending", { mcpServers: s.mcpServers }));
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, prompt, ...(attachments?.length ? { attachments } : {}) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
        throw new Error(err.error);
      }
      retryCountRef.current = 0;
      connectStream(sessionId);
    } catch (err) {
      setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
      throw err;
    }
  }, [sessionId, connectStream]);

  const abortSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${sessionId}/abort`, { method: "POST" });
    } catch (err) {
      console.error("[stream] Abort failed:", err);
    }
  }, [sessionId]);

  const reconnect = useCallback((sid: string) => {
    connectStream(sid);
  }, [connectStream]);

  return { ...streamState, sendMessage, abortSession, reconnect };
}
