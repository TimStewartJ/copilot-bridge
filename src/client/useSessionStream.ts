import { useState, useEffect, useRef, useCallback } from "react";
import type { Attachment, ChatEntry, McpServerStatus, ToolArgs, ToolCall } from "./api";
import { API_BASE, startFleetRun } from "./api";

export interface PendingTool {
  toolCallId: string;
  name: string;
  args?: ToolArgs;
  parentToolCallId?: string;
  isSubAgent?: boolean;
  startedAt?: string;
  progressText?: string;
}

export type StreamStatus = "idle" | "sending" | "thinking" | "streaming";
export type PendingOrigin = "message" | "fleet" | "reconnect" | null;

export interface StreamState {
  streamingContent: string;
  activeTools: PendingTool[];
  intentText: string;
  streamStatus: StreamStatus;
  isStreaming: boolean;
  hadVisibleOutput: boolean;
  mcpServers: McpServerStatus[];
  pendingOrigin: PendingOrigin;
}

function createToolEntry(
  tool: Pick<PendingTool, "toolCallId" | "name" | "args" | "parentToolCallId" | "isSubAgent" | "startedAt" | "progressText">,
  partial: Partial<ToolCall> = {},
): ChatEntry {
  return {
    type: "tool",
    toolCall: {
      toolCallId: tool.toolCallId,
      name: tool.name,
      args: tool.args,
      parentToolCallId: tool.parentToolCallId,
      isSubAgent: tool.isSubAgent,
      startedAt: tool.startedAt,
      progressText: tool.progressText,
      ...partial,
    },
  };
}

function getRenameTargetSessionId(args: ToolArgs | undefined): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).sessionId;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isHiddenTool(name: string, args: ToolArgs | undefined, sessionId: string): boolean {
  if (name === "report_intent") return true;
  if (name !== "session_rename") return false;
  const targetSessionId = getRenameTargetSessionId(args);
  return targetSessionId === undefined || targetSessionId === sessionId;
}

function formatTerminalContent(content: string, terminalType?: string): string {
  if (terminalType === "aborted") return `${content}\n\n*(stopped)*`;
  if (terminalType === "shutdown") return `${content}\n\n*(interrupted)*`;
  return content;
}

export function useSessionStream(
  sessionId: string | null,
  onEntriesAppended: (entries: ChatEntry[]) => void,
  onTitleChanged: () => void,
) {
  const mkState = (status: StreamStatus, partial?: Partial<StreamState>): StreamState => ({
    streamingContent: "",
    activeTools: [],
    intentText: "",
    hadVisibleOutput: false,
    mcpServers: [],
    pendingOrigin: null,
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

  const connectStream = useCallback((sid: string, pendingOrigin: PendingOrigin = "reconnect") => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStreamState((s) => mkState("sending", { mcpServers: s.mcpServers, pendingOrigin }));

    fetch(`${API_BASE}/api/sessions/${sid}/stream`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedContent = "";
        const refreshTitle = (withRetries = false) => {
          onTitleChangedRef.current();
          if (!withRetries) return;
          setTimeout(() => onTitleChangedRef.current(), 5_000);
          setTimeout(() => onTitleChangedRef.current(), 12_000);
        };

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
                    if (event.errorMessage) {
                      onEntriesRef.current([{ role: "assistant", content: `⚠️ Error: ${event.errorMessage}` }]);
                    } else if (typeof event.finalContent === "string" && event.finalContent.length > 0) {
                      const text = formatTerminalContent(event.finalContent, event.terminalType);
                      onEntriesRef.current([{ role: "assistant", content: text }]);
                    }
                    setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                    refreshTitle(event.terminalType === "done");
                    break;
                  }
                  if (event.pendingPrompt) {
                    onEntriesRef.current([{ role: "user", content: event.pendingPrompt }]);
                  }
                  accumulatedContent = event.accumulatedContent ?? "";
                  const tools: PendingTool[] = (event.activeTools ?? [])
                    .filter((t: any) => !isHiddenTool(t.name ?? "unknown", t.args, sid))
                    .map((t: any) => ({
                      toolCallId: t.toolCallId ?? "",
                      name: t.name ?? "unknown",
                      args: t.args,
                      startedAt: t.startedAt,
                      progressText: t.progressText,
                      parentToolCallId: t.parentToolCallId,
                      isSubAgent: t.isSubAgent,
                    }));
                  activeToolMeta.clear();
                  for (const t of tools) activeToolMeta.set(t.toolCallId, t);
                  if (tools.length > 0) {
                    onEntriesRef.current(tools.map((tool) => createToolEntry(tool)));
                  }
                  setStreamState((prev) => ({
                    ...prev,
                    streamingContent: accumulatedContent,
                    activeTools: tools,
                    intentText: event.intentText ?? "",
                    mcpServers: event.mcpServers ?? prev.mcpServers,
                    streamStatus: accumulatedContent || tools.length > 0 ? "streaming" : "thinking",
                    isStreaming: true,
                    hadVisibleOutput: prev.hadVisibleOutput || Boolean(accumulatedContent || tools.length > 0),
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
                    hadVisibleOutput: true,
                  }));
                  break;
                case "assistant_partial":
                  if (event.content) {
                    onEntriesRef.current([{ role: "assistant", content: event.content }]);
                  }
                  const partialHadVisibleOutput = Boolean(accumulatedContent || event.content);
                  accumulatedContent = "";
                  setStreamState((s) => ({
                    ...s,
                    streamingContent: "",
                    hadVisibleOutput: s.hadVisibleOutput || partialHadVisibleOutput,
                  }));
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
                  if (isHiddenTool(tool.name, tool.args, sid)) break;
                  activeToolMeta.set(tool.toolCallId, tool);
                  onEntriesRef.current([createToolEntry(tool)]);
                  setStreamState((s) => ({
                    ...s,
                    activeTools: [...s.activeTools, tool],
                    streamStatus: "streaming",
                    isStreaming: true,
                    hadVisibleOutput: true,
                  }));
                  break;
                }
                case "tool_progress":
                  if (typeof event.toolCallId === "string") {
                    const meta = activeToolMeta.get(event.toolCallId);
                    if (meta) meta.progressText = event.message ?? meta.progressText;
                    const nextTool = meta ?? {
                      toolCallId: event.toolCallId,
                      name: event.name ?? "unknown",
                      progressText: event.message ?? "",
                    };
                    onEntriesRef.current([createToolEntry(nextTool, { progressText: event.message ?? nextTool.progressText })]);
                    setStreamState((s) => ({
                      ...s,
                      activeTools: s.activeTools.map((tool) =>
                        tool.toolCallId === event.toolCallId
                          ? { ...tool, progressText: event.message ?? tool.progressText }
                          : tool,
                      ),
                    }));
                  }
                  break;
                case "tool_output":
                  if (typeof event.toolCallId === "string") {
                    const meta = activeToolMeta.get(event.toolCallId);
                    if (meta) meta.progressText = event.content ?? meta.progressText;
                    const nextTool = meta ?? {
                      toolCallId: event.toolCallId,
                      name: event.name ?? "unknown",
                      progressText: event.content ?? "",
                    };
                    onEntriesRef.current([createToolEntry(nextTool, { progressText: event.content ?? nextTool.progressText })]);
                    setStreamState((s) => ({
                      ...s,
                      activeTools: s.activeTools.map((tool) =>
                        tool.toolCallId === event.toolCallId
                          ? { ...tool, progressText: event.content ?? tool.progressText }
                          : tool,
                      ),
                    }));
                  }
                  break;
                case "tool_update": {
                  const meta = activeToolMeta.get(event.toolCallId as string);
                  if (meta) {
                    meta.name = event.name ?? meta.name;
                    meta.isSubAgent = (event.isSubAgent as boolean) ?? meta.isSubAgent;
                    onEntriesRef.current([createToolEntry(meta)]);
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
                  const meta = activeToolMeta.get(event.toolCallId);
                  const toolName = meta?.name ?? event.name ?? "unknown";
                  const toolArgs = meta?.args;
                  if (isHiddenTool(toolName, toolArgs, sid)) break;
                  activeToolMeta.delete(event.toolCallId);
                  const tc: ToolCall = {
                    toolCallId: event.toolCallId ?? "",
                    name: toolName,
                    args: meta?.args,
                    result: event.result,
                    progressText: meta?.progressText,
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
                    hadVisibleOutput: true,
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
                  refreshTitle(true);
                  accumulatedContent = "";
                  break;
                case "aborted": {
                  const text = event.content || accumulatedContent;
                  if (text) {
                    onEntriesRef.current([{ role: "assistant", content: formatTerminalContent(text, "aborted") }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                  accumulatedContent = "";
                  break;
                }
                case "shutdown": {
                  const text = event.content || accumulatedContent;
                  if (text) {
                    onEntriesRef.current([{ role: "assistant", content: formatTerminalContent(text, "shutdown") }]);
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
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
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
          setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
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

  const sendMessage = useCallback(async (prompt: string, attachments?: Attachment[]) => {
    if (!sessionId) return;
    setStreamState((s) => mkState("sending", { mcpServers: s.mcpServers, pendingOrigin: "message" }));
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
      connectStream(sessionId, "message");
    } catch (err) {
      setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
      throw err;
    }
  }, [sessionId, connectStream]);

  const startFleet = useCallback(async (prompt?: string) => {
    if (!sessionId) return;
    setStreamState((s) => mkState("sending", { mcpServers: s.mcpServers, pendingOrigin: "fleet" }));
    try {
      await startFleetRun(sessionId, prompt);
      retryCountRef.current = 0;
      connectStream(sessionId, "fleet");
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
    connectStream(sid, "reconnect");
  }, [connectStream]);

  return { ...streamState, sendMessage, startFleet, abortSession, reconnect };
}
