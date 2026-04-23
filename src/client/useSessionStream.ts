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

export interface PendingToolPrelude {
  toolCallId: string;
  name?: string;
  progressText?: string;
  isSubAgent?: boolean;
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

function upsertPendingTool(tools: PendingTool[], nextTool: PendingTool): PendingTool[] {
  const existingIndex = tools.findIndex((tool) => tool.toolCallId === nextTool.toolCallId);
  if (existingIndex < 0) return [...tools, nextTool];
  return tools.map((tool, index) => (
    index === existingIndex
      ? { ...tool, ...nextTool, toolCallId: tool.toolCallId }
      : tool
  ));
}

function patchPendingTool(tools: PendingTool[], toolCallId: string, patch: Partial<PendingTool>): PendingTool[] {
  return tools.map((tool) => (
    tool.toolCallId === toolCallId
      ? { ...tool, ...patch, toolCallId: tool.toolCallId }
      : tool
  ));
}

function removePendingTool(tools: PendingTool[], toolCallId: string): PendingTool[] {
  return tools.filter((tool) => tool.toolCallId !== toolCallId);
}

export function getKnownToolName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const normalized = name.trim();
  return normalized && normalized !== "unknown" ? normalized : undefined;
}

export function bufferPendingToolPrelude(
  existing: PendingToolPrelude | undefined,
  patch: PendingToolPrelude,
): PendingToolPrelude {
  return {
    toolCallId: patch.toolCallId,
    name: patch.name ?? existing?.name,
    progressText: patch.progressText ?? existing?.progressText,
    isSubAgent: patch.isSubAgent ?? existing?.isSubAgent,
  };
}

export function resolvePendingToolName(name: unknown, prelude?: PendingToolPrelude): string {
  return getKnownToolName(name) ?? prelude?.name ?? "unknown";
}

export function materializePendingTool<T extends Pick<PendingTool, "name" | "progressText" | "isSubAgent">>(
  tool: T,
  prelude?: PendingToolPrelude,
): T {
  if (!prelude) return tool;
  return {
    ...tool,
    progressText: prelude.progressText ?? tool.progressText,
    isSubAgent: tool.isSubAgent ?? prelude.isSubAgent,
  };
}

export function collectTerminalPendingTools(
  activeTools: Iterable<PendingTool>,
  renderedTools: PendingTool[],
  preludes: Iterable<PendingToolPrelude>,
): PendingTool[] {
  const collected: PendingTool[] = [];
  const indexByToolCallId = new Map<string, number>();
  const upsert = (tool: PendingTool) => {
    const existingIndex = indexByToolCallId.get(tool.toolCallId);
    if (existingIndex === undefined) {
      indexByToolCallId.set(tool.toolCallId, collected.length);
      collected.push(tool);
      return;
    }
    const existing = collected[existingIndex];
    collected[existingIndex] = {
      ...existing,
      ...tool,
      toolCallId: existing.toolCallId,
      name: getKnownToolName(tool.name) ?? getKnownToolName(existing.name) ?? tool.name ?? existing.name,
      args: tool.args ?? existing.args,
      parentToolCallId: tool.parentToolCallId ?? existing.parentToolCallId,
      isSubAgent: tool.isSubAgent ?? existing.isSubAgent,
      startedAt: tool.startedAt ?? existing.startedAt,
      progressText: tool.progressText ?? existing.progressText,
    };
  };

  for (const tool of renderedTools) upsert(tool);
  for (const tool of activeTools) upsert(tool);
  for (const prelude of preludes) {
    upsert(materializePendingTool({
      toolCallId: prelude.toolCallId,
      name: resolvePendingToolName(undefined, prelude),
    }, prelude));
  }

  return collected;
}

function createToolEntry(
  tool: Pick<PendingTool, "toolCallId" | "name" | "args" | "parentToolCallId" | "isSubAgent" | "startedAt" | "progressText">,
  partial: Partial<ToolCall> = {},
  liveSource: "snapshot" | "event" = "event",
): ChatEntry {
  return {
    type: "tool",
    liveSource,
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

export function buildTerminalToolEntries(
  tools: PendingTool[],
  terminalType: "done" | "error" | "aborted" | "shutdown",
  completedAt?: string,
): ChatEntry[] {
  return tools.map((tool) => createToolEntry(tool, {
    success: terminalType === "done",
    ...(completedAt ? { completedAt } : {}),
  }));
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
  const renderedActiveToolsRef = useRef<PendingTool[]>([]);

  const connectStream = useCallback((sid: string, pendingOrigin: PendingOrigin = "reconnect") => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    if (pendingOrigin !== "reconnect") {
      renderedActiveToolsRef.current = [];
    }
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
        const pendingToolPrelude = new Map<string, PendingToolPrelude>();
        const emitTerminalToolEntries = (
          terminalType: "done" | "error" | "aborted" | "shutdown",
          completedAt?: string,
        ) => {
          const tools = collectTerminalPendingTools(
            activeToolMeta.values(),
            renderedActiveToolsRef.current,
            pendingToolPrelude.values(),
          ).filter((tool) => !isHiddenTool(tool.name, tool.args, sid));
          if (tools.length > 0) {
            onEntriesRef.current(buildTerminalToolEntries(tools, terminalType, completedAt));
          }
          activeToolMeta.clear();
          pendingToolPrelude.clear();
          renderedActiveToolsRef.current = [];
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
                  if (event.complete) {
                    emitTerminalToolEntries(
                      event.terminalType ?? (event.errorMessage ? "error" : "done"),
                      event.terminalTimestamp ?? event.timestamp,
                    );
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
                  pendingToolPrelude.clear();
                  for (const t of tools) activeToolMeta.set(t.toolCallId, t);
                  renderedActiveToolsRef.current = tools;
                  if (tools.length > 0) {
                    onEntriesRef.current(tools.map((tool) => createToolEntry(tool, {}, "snapshot")));
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
                  const prelude = event.toolCallId ? pendingToolPrelude.get(event.toolCallId) : undefined;
                  const tool = materializePendingTool<PendingTool>({
                    toolCallId: event.toolCallId ?? "",
                    name: resolvePendingToolName(event.name, prelude),
                    args: event.args,
                    parentToolCallId: event.parentToolCallId,
                    isSubAgent: event.isSubAgent,
                    startedAt: event.timestamp,
                  }, prelude);
                  if (tool.toolCallId) pendingToolPrelude.delete(tool.toolCallId);
                  if (isHiddenTool(tool.name, tool.args, sid)) break;
                  activeToolMeta.set(tool.toolCallId, tool);
                  renderedActiveToolsRef.current = upsertPendingTool(renderedActiveToolsRef.current, tool);
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
                    if (meta) {
                      meta.progressText = event.message ?? meta.progressText;
                      const nextTool = {
                        ...meta,
                        progressText: event.message ?? meta.progressText,
                      };
                      renderedActiveToolsRef.current = upsertPendingTool(renderedActiveToolsRef.current, nextTool);
                      onEntriesRef.current([createToolEntry(nextTool)]);
                    } else {
                      pendingToolPrelude.set(
                        event.toolCallId,
                        bufferPendingToolPrelude(pendingToolPrelude.get(event.toolCallId), {
                          toolCallId: event.toolCallId,
                          name: getKnownToolName(event.name),
                          progressText: event.message ?? "",
                        }),
                      );
                    }
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
                    if (meta) {
                      meta.progressText = event.content ?? meta.progressText;
                      const nextTool = {
                        ...meta,
                        progressText: event.content ?? meta.progressText,
                      };
                      renderedActiveToolsRef.current = upsertPendingTool(renderedActiveToolsRef.current, nextTool);
                      onEntriesRef.current([createToolEntry(nextTool)]);
                    } else {
                      pendingToolPrelude.set(
                        event.toolCallId,
                        bufferPendingToolPrelude(pendingToolPrelude.get(event.toolCallId), {
                          toolCallId: event.toolCallId,
                          name: getKnownToolName(event.name),
                          progressText: event.content ?? "",
                        }),
                      );
                    }
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
                    renderedActiveToolsRef.current = upsertPendingTool(renderedActiveToolsRef.current, {
                      ...meta,
                      name: event.name ?? meta.name,
                      isSubAgent: (event.isSubAgent as boolean) ?? meta.isSubAgent,
                    });
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
                  if (!meta && typeof event.toolCallId === "string") {
                    pendingToolPrelude.set(
                      event.toolCallId,
                      bufferPendingToolPrelude(pendingToolPrelude.get(event.toolCallId), {
                        toolCallId: event.toolCallId,
                        name: getKnownToolName(event.name),
                        isSubAgent: event.isSubAgent as boolean | undefined,
                      }),
                    );
                  }
                  break;
                }
                case "tool_done": {
                  const meta = activeToolMeta.get(event.toolCallId);
                  const prelude = pendingToolPrelude.get(event.toolCallId);
                  const toolName = meta?.name ?? resolvePendingToolName(event.name, prelude);
                  const toolArgs = meta?.args;
                  pendingToolPrelude.delete(event.toolCallId);
                  if (isHiddenTool(toolName, toolArgs, sid)) break;
                  activeToolMeta.delete(event.toolCallId);
                  renderedActiveToolsRef.current = removePendingTool(renderedActiveToolsRef.current, event.toolCallId);
                  const tc: ToolCall = {
                    toolCallId: event.toolCallId ?? "",
                    name: toolName,
                    args: meta?.args,
                    result: event.result,
                    progressText: meta?.progressText ?? prelude?.progressText,
                    success: event.success,
                    parentToolCallId: meta?.parentToolCallId ?? event.parentToolCallId,
                    isSubAgent: meta?.isSubAgent ?? prelude?.isSubAgent ?? event.isSubAgent,
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
                  emitTerminalToolEntries("done", event.timestamp);
                  if (event.content) {
                    onEntriesRef.current([{ role: "assistant", content: event.content }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                  refreshTitle(true);
                  accumulatedContent = "";
                  break;
                case "aborted": {
                  emitTerminalToolEntries("aborted", event.timestamp);
                  const text = event.content || accumulatedContent;
                  if (text) {
                    onEntriesRef.current([{ role: "assistant", content: formatTerminalContent(text, "aborted") }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                  accumulatedContent = "";
                  break;
                }
                case "shutdown": {
                  emitTerminalToolEntries("shutdown", event.timestamp);
                  const text = event.content || accumulatedContent;
                  if (text) {
                    onEntriesRef.current([{ role: "assistant", content: formatTerminalContent(text, "shutdown") }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers }));
                  accumulatedContent = "";
                  break;
                }
                case "error":
                  emitTerminalToolEntries("error", event.timestamp);
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
    renderedActiveToolsRef.current = [];
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
