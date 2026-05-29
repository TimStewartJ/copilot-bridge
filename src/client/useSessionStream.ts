import { useState, useEffect, useRef, useCallback } from "react";
import type {
  Attachment,
  ChatEntry,
  ChatVisualEntry,
  McpServerStatus,
  PendingUserInputRequestView,
  ToolArgs,
  ToolCall,
  VisualArtifact,
} from "./api";
import { API_BASE, sendChatMessage } from "./api";
import type { SessionContextSummary } from "../shared/session-context.js";
import type { SendMode } from "../shared/send-mode.js";

export interface PendingTool {
  toolCallId: string;
  name: string;
  turnId?: string;
  args?: ToolArgs;
  parentToolCallId?: string;
  isSubAgent?: boolean;
  startedAt?: string;
  progressText?: string;
}

interface SnapshotTool extends PendingTool {
  result?: string;
  success?: boolean;
  completedAt?: string;
}

export interface PendingToolPrelude {
  toolCallId: string;
  turnId?: string;
  name?: string;
  progressText?: string;
  isSubAgent?: boolean;
}

export type StreamStatus = "idle" | "sending" | "thinking" | "streaming";
export type PendingOrigin = "message" | "reconnect" | null;

export interface StreamState {
  streamingContent: string;
  activeTools: PendingTool[];
  pendingUserInputs: PendingUserInputRequestView[];
  currentTurnTools: ToolCall[];
  intentText: string;
  streamStatus: StreamStatus;
  isStreaming: boolean;
  hadVisibleOutput: boolean;
  mcpServers: McpServerStatus[];
  contextSummary: SessionContextSummary | null;
  pendingOrigin: PendingOrigin;
  runMode?: SendMode;
}

const VISUAL_KIND_MIME_TYPES: Record<VisualArtifact["kind"], string> = {
  image: "image/png",
  mermaid: "text/vnd.mermaid",
  "vega-lite": "application/vnd.vegalite+json",
  html: "text/html",
};

function isVisualArtifactKind(value: unknown): value is VisualArtifact["kind"] {
  return value === "image" || value === "mermaid" || value === "vega-lite" || value === "html";
}

export function createVisualEntryFromPublishedEvent(event: Record<string, unknown>): ChatVisualEntry | null {
  if (typeof event.artifactId !== "string" || typeof event.url !== "string") return null;
  const kind = isVisualArtifactKind(event.kind) ? event.kind : "image";
  const displayName = typeof event.displayName === "string" ? event.displayName : event.artifactId;
  const visual: VisualArtifact = {
    artifactId: event.artifactId,
    kind,
    title: typeof event.title === "string" ? event.title : displayName,
    displayName,
    mimeType: typeof event.mimeType === "string" ? event.mimeType : VISUAL_KIND_MIME_TYPES[kind],
    size: typeof event.size === "number" ? event.size : 0,
    url: event.url,
    downloadUrl: typeof event.downloadUrl === "string" ? event.downloadUrl : event.url,
    ...(typeof event.caption === "string" ? { caption: event.caption } : {}),
    ...(typeof event.altText === "string" ? { altText: event.altText } : {}),
    ...(kind !== "image" && typeof event.source === "string" ? { source: event.source } : {}),
  };

  return {
    id: `stream-visual-${event.artifactId}`,
    type: "visual",
    visual,
    ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
  };
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

function normalizePendingUserInputRequest(
  input: unknown,
  fallbackTimestamp?: string,
): PendingUserInputRequestView | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.requestId !== "string" || typeof record.question !== "string") {
    return undefined;
  }

  const request: PendingUserInputRequestView = {
    requestId: record.requestId,
    question: record.question,
    allowFreeform: typeof record.allowFreeform === "boolean" ? record.allowFreeform : true,
  };
  if (Array.isArray(record.choices)) {
    request.choices = record.choices.filter((choice): choice is string => typeof choice === "string");
  }
  const requestedAt = typeof record.requestedAt === "string" ? record.requestedAt : fallbackTimestamp;
  if (requestedAt) request.requestedAt = requestedAt;
  if (typeof record.toolCallId === "string") request.toolCallId = record.toolCallId;
  return request;
}

function normalizePendingUserInputRequests(input: unknown): PendingUserInputRequestView[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((request) => {
    const normalized = normalizePendingUserInputRequest(request);
    return normalized ? [normalized] : [];
  });
}

function upsertPendingUserInput(
  requests: PendingUserInputRequestView[],
  nextRequest: PendingUserInputRequestView,
): PendingUserInputRequestView[] {
  const existingIndex = requests.findIndex((request) => request.requestId === nextRequest.requestId);
  if (existingIndex < 0) return [...requests, nextRequest];
  return requests.map((request, index) => (
    index === existingIndex
      ? { ...request, ...nextRequest, requestId: request.requestId }
      : request
  ));
}

function removePendingUserInput(
  requests: PendingUserInputRequestView[],
  requestId: string,
): PendingUserInputRequestView[] {
  return requests.filter((request) => request.requestId !== requestId);
}

function pendingToolToToolCall(tool: PendingTool, partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: tool.toolCallId,
    name: tool.name,
    args: tool.args,
    parentToolCallId: tool.parentToolCallId,
    isSubAgent: tool.isSubAgent,
    startedAt: tool.startedAt,
    progressText: tool.progressText,
    ...partial,
  };
}

function upsertToolCall(tools: ToolCall[], nextTool: ToolCall): ToolCall[] {
  const existingIndex = tools.findIndex((tool) => tool.toolCallId === nextTool.toolCallId);
  if (existingIndex < 0) return [...tools, nextTool];
  return tools.map((tool, index) => (
    index === existingIndex
      ? {
          ...tool,
          ...nextTool,
          toolCallId: tool.toolCallId,
          name: getKnownToolName(nextTool.name) ?? getKnownToolName(tool.name) ?? nextTool.name,
          args: nextTool.args ?? tool.args,
          result: nextTool.result ?? tool.result,
          progressText: nextTool.progressText ?? tool.progressText,
          success: nextTool.success ?? tool.success,
          parentToolCallId: nextTool.parentToolCallId ?? tool.parentToolCallId,
          isSubAgent: nextTool.isSubAgent ?? tool.isSubAgent,
          childToolCalls: nextTool.childToolCalls ?? tool.childToolCalls,
          startedAt: nextTool.startedAt ?? tool.startedAt,
          completedAt: nextTool.completedAt ?? tool.completedAt,
        }
      : tool
  ));
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
    turnId: patch.turnId ?? existing?.turnId,
    name: patch.name ?? existing?.name,
    progressText: patch.progressText ?? existing?.progressText,
    isSubAgent: patch.isSubAgent ?? existing?.isSubAgent,
  };
}

export function resolvePendingToolName(name: unknown, prelude?: PendingToolPrelude): string {
  return getKnownToolName(name) ?? prelude?.name ?? "unknown";
}

export function materializePendingTool<T extends Pick<PendingTool, "name" | "progressText" | "isSubAgent"> & { turnId?: string }>(
  tool: T,
  prelude?: PendingToolPrelude,
): T {
  if (!prelude) return tool;
  return {
    ...tool,
    turnId: tool.turnId ?? prelude.turnId,
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
      turnId: tool.turnId ?? existing.turnId,
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
      turnId: prelude.turnId,
    }, prelude));
  }

  return collected;
}

function createToolEntry(
  tool: Pick<PendingTool, "toolCallId" | "name" | "turnId" | "args" | "parentToolCallId" | "isSubAgent" | "startedAt" | "progressText">,
  partial: Partial<ToolCall> = {},
  liveSource: "snapshot" | "event" = "event",
): ChatEntry {
  return {
    type: "tool",
    ...(tool.turnId ? { turnId: tool.turnId } : {}),
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

function getEventTurnId(event: { turnId?: unknown }): string | undefined {
  return typeof event.turnId === "string" && event.turnId ? event.turnId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeStreamContextSummary(value: unknown): SessionContextSummary | null {
  if (!isRecord(value)) return null;
  const summary = isRecord(value.summary) ? value.summary : value;
  return summary as unknown as SessionContextSummary;
}

function getStreamContextSummary(event: Record<string, unknown>): SessionContextSummary | null {
  const directSummary = event.type === "context_status" || event.type === "context" || event.type === "context_update"
    ? normalizeStreamContextSummary(event)
    : null;
  return normalizeStreamContextSummary(event.summary)
    ?? normalizeStreamContextSummary(event.contextSummary)
    ?? normalizeStreamContextSummary(isRecord(event.context) ? event.context.summary : undefined)
    ?? normalizeStreamContextSummary(event.context)
    ?? normalizeStreamContextSummary(event.context_status)
    ?? normalizeStreamContextSummary(event.contextStatus)
    ?? directSummary;
}

function normalizeSnapshotTool(rawTool: unknown, activeTurnId: string | undefined): SnapshotTool | undefined {
  if (!isRecord(rawTool)) return undefined;
  return {
    toolCallId: optionalString(rawTool.toolCallId) ?? "",
    name: optionalString(rawTool.name) ?? "unknown",
    turnId: optionalString(rawTool.turnId) ?? activeTurnId,
    args: rawTool.args as ToolArgs | undefined,
    startedAt: optionalString(rawTool.startedAt),
    progressText: optionalString(rawTool.progressText),
    parentToolCallId: optionalString(rawTool.parentToolCallId),
    isSubAgent: optionalBoolean(rawTool.isSubAgent),
    result: optionalString(rawTool.result),
    success: optionalBoolean(rawTool.success),
    completedAt: optionalString(rawTool.completedAt),
  };
}

function mergeSnapshotTool(existing: SnapshotTool, nextTool: SnapshotTool): SnapshotTool {
  return {
    ...existing,
    ...nextTool,
    toolCallId: existing.toolCallId,
    name: getKnownToolName(nextTool.name) ?? getKnownToolName(existing.name) ?? nextTool.name,
    args: nextTool.args !== undefined ? nextTool.args : existing.args,
    parentToolCallId: nextTool.parentToolCallId ?? existing.parentToolCallId,
    isSubAgent: nextTool.isSubAgent ?? existing.isSubAgent,
    turnId: nextTool.turnId ?? existing.turnId,
    startedAt: nextTool.startedAt ?? existing.startedAt,
    progressText: nextTool.progressText ?? existing.progressText,
    result: nextTool.result ?? existing.result,
    success: nextTool.success ?? existing.success,
    completedAt: nextTool.completedAt ?? existing.completedAt,
  };
}

function normalizeSnapshotTools(rawTools: unknown, activeTurnId: string | undefined, sessionId: string): SnapshotTool[] {
  if (!Array.isArray(rawTools)) return [];
  const tools: SnapshotTool[] = [];
  const indexByToolCallId = new Map<string, number>();
  for (const rawTool of rawTools) {
    const tool = normalizeSnapshotTool(rawTool, activeTurnId);
    if (!tool || isHiddenTool(tool.name, tool.args, sessionId)) continue;
    const existingIndex = indexByToolCallId.get(tool.toolCallId);
    if (existingIndex === undefined) {
      indexByToolCallId.set(tool.toolCallId, tools.length);
      tools.push(tool);
    } else {
      tools[existingIndex] = mergeSnapshotTool(tools[existingIndex], tool);
    }
  }
  return tools;
}

function createSnapshotToolEntry(tool: SnapshotTool): ChatEntry {
  return createToolEntry(tool, {
    result: tool.result,
    success: tool.success,
    completedAt: tool.completedAt,
  }, "snapshot");
}

function snapshotToolToToolCall(tool: SnapshotTool): ToolCall {
  return pendingToolToToolCall(tool, {
    result: tool.result,
    success: tool.success,
    completedAt: tool.completedAt,
  });
}

export function buildSnapshotToolState(
  event: { activeTools?: unknown; currentTurnTools?: unknown; turnId?: unknown },
  sessionId: string,
): { activeTools: PendingTool[]; currentTurnTools: ToolCall[]; toolEntries: ChatEntry[] } {
  const activeTurnId = getEventTurnId(event);
  const activeTools = normalizeSnapshotTools(event.activeTools, activeTurnId, sessionId);
  const snapshotToolSource = Array.isArray(event.currentTurnTools)
    ? event.currentTurnTools
    : event.activeTools;
  const snapshotTools = normalizeSnapshotTools(snapshotToolSource, activeTurnId, sessionId);
  return {
    activeTools,
    currentTurnTools: snapshotTools.map((tool) => snapshotToolToToolCall(tool)),
    toolEntries: snapshotTools.map((tool) => createSnapshotToolEntry(tool)),
  };
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
    pendingUserInputs: [],
    currentTurnTools: [],
    intentText: "",
    hadVisibleOutput: false,
    mcpServers: [],
    contextSummary: null,
    pendingOrigin: null,
    ...partial,
    streamStatus: status,
    isStreaming: status !== "idle",
  });

  const [streamState, setStreamState] = useState<StreamState>(mkState("idle"));
  const streamStateRef = useRef(streamState);
  streamStateRef.current = streamState;

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);

  const onEntriesRef = useRef(onEntriesAppended);
  onEntriesRef.current = onEntriesAppended;
  const onTitleChangedRef = useRef(onTitleChanged);
  onTitleChangedRef.current = onTitleChanged;

  const retryCountRef = useRef(0);
  const renderedActiveToolsRef = useRef<PendingTool[]>([]);

  const connectStream = useCallback((sid: string, pendingOrigin: PendingOrigin = "reconnect", runMode?: SendMode) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    if (pendingOrigin !== "reconnect") {
      renderedActiveToolsRef.current = [];
    }
    setStreamState((s) => mkState("sending", {
      mcpServers: s.mcpServers,
      contextSummary: s.contextSummary,
      pendingOrigin,
      runMode: runMode ?? s.runMode,
      pendingUserInputs: pendingOrigin === "reconnect" ? s.pendingUserInputs : [],
    }));

    fetch(`${API_BASE}/api/sessions/${sid}/stream`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedContent = "";
        let activeTurnId: string | undefined;
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
          const groupedTools = activeTurnId
            ? tools.map((tool) => tool.turnId ? tool : { ...tool, turnId: activeTurnId })
            : tools;
          if (groupedTools.length > 0) {
            onEntriesRef.current(buildTerminalToolEntries(groupedTools, terminalType, completedAt));
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
                    const turnId = getEventTurnId(event);
                    activeTurnId = turnId;
                    emitTerminalToolEntries(
                      event.terminalType ?? (event.errorMessage ? "error" : "done"),
                      event.terminalTimestamp ?? event.timestamp,
                    );
                    if (event.errorMessage) {
                      onEntriesRef.current([{
                        role: "assistant",
                        content: `⚠️ Error: ${event.errorMessage}`,
                        ...(event.terminalTimestamp ? { timestamp: event.terminalTimestamp } : {}),
                        ...(turnId ? { turnId } : {}),
                      }]);
                    } else if (typeof event.finalContent === "string" && event.finalContent.length > 0) {
                      const text = formatTerminalContent(event.finalContent, event.terminalType);
                      onEntriesRef.current([{
                        role: "assistant",
                        content: text,
                        ...(event.terminalTimestamp ? { timestamp: event.terminalTimestamp } : {}),
                        ...(turnId ? { turnId } : {}),
                      }]);
                    }
                    activeTurnId = undefined;
                    setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
                    refreshTitle(event.terminalType === "done");
                    break;
                  }
                  if (event.pendingPrompt) {
                    onEntriesRef.current([{ role: "user", content: event.pendingPrompt }]);
                  }
                  accumulatedContent = event.accumulatedContent ?? "";
                  activeTurnId = getEventTurnId(event);
                  const pendingUserInputs = normalizePendingUserInputRequests(event.pendingUserInputs);
                  const snapshotToolState = buildSnapshotToolState(event, sid);
                  const tools = snapshotToolState.activeTools;
                  const contextSummary = getStreamContextSummary(event);
                  activeToolMeta.clear();
                  pendingToolPrelude.clear();
                  for (const t of tools) activeToolMeta.set(t.toolCallId, t);
                  renderedActiveToolsRef.current = tools;
                  if (snapshotToolState.toolEntries.length > 0) {
                    onEntriesRef.current(snapshotToolState.toolEntries);
                  }
                  const hasVisibleSnapshotOutput = Boolean(accumulatedContent || snapshotToolState.toolEntries.length > 0);
                  setStreamState((prev) => ({
                    ...prev,
                    streamingContent: accumulatedContent,
                    activeTools: tools,
                    pendingUserInputs,
                    currentTurnTools: snapshotToolState.currentTurnTools,
                    intentText: event.intentText ?? "",
                    mcpServers: event.mcpServers ?? prev.mcpServers,
                    contextSummary: contextSummary ?? prev.contextSummary,
                    streamStatus: hasVisibleSnapshotOutput || tools.length > 0 ? "streaming" : "thinking",
                    isStreaming: true,
                    hadVisibleOutput: prev.hadVisibleOutput || hasVisibleSnapshotOutput || tools.length > 0,
                  }));
                  break;
                }
                case "thinking":
                  activeTurnId = getEventTurnId(event);
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
                    const turnId = getEventTurnId(event);
                    onEntriesRef.current([{
                      role: "assistant",
                      content: event.content,
                      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
                      ...(turnId ? { turnId } : {}),
                    }]);
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
                  const turnId = getEventTurnId(event);
                  const prelude = event.toolCallId ? pendingToolPrelude.get(event.toolCallId) : undefined;
                  const tool = materializePendingTool<PendingTool>({
                    toolCallId: event.toolCallId ?? "",
                    name: resolvePendingToolName(event.name, prelude),
                    turnId: turnId ?? prelude?.turnId,
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
                    activeTools: upsertPendingTool(s.activeTools, tool),
                    currentTurnTools: upsertToolCall(s.currentTurnTools, pendingToolToToolCall(tool)),
                    streamStatus: "streaming",
                    isStreaming: true,
                    hadVisibleOutput: true,
                  }));
                  break;
                }
                case "tool_progress":
                  if (typeof event.toolCallId === "string") {
                    const turnId = getEventTurnId(event);
                    const meta = activeToolMeta.get(event.toolCallId);
                    let nextCurrentTurnTool: ToolCall | undefined;
                    if (meta) {
                      meta.turnId = meta.turnId ?? turnId;
                      meta.progressText = event.message ?? meta.progressText;
                      const nextTool = {
                        ...meta,
                        turnId: meta.turnId ?? turnId,
                        progressText: event.message ?? meta.progressText,
                      };
                      nextCurrentTurnTool = pendingToolToToolCall(nextTool);
                      renderedActiveToolsRef.current = upsertPendingTool(renderedActiveToolsRef.current, nextTool);
                      onEntriesRef.current([createToolEntry(nextTool)]);
                    } else {
                      pendingToolPrelude.set(
                        event.toolCallId,
                        bufferPendingToolPrelude(pendingToolPrelude.get(event.toolCallId), {
                          toolCallId: event.toolCallId,
                          turnId,
                          name: getKnownToolName(event.name),
                          progressText: event.message ?? "",
                        }),
                      );
                    }
                    setStreamState((s) => ({
                      ...s,
                      activeTools: s.activeTools.map((tool) =>
                        tool.toolCallId === event.toolCallId
                          ? { ...tool, turnId: tool.turnId ?? turnId, progressText: event.message ?? tool.progressText }
                          : tool,
                      ),
                      currentTurnTools: nextCurrentTurnTool
                        ? upsertToolCall(s.currentTurnTools, nextCurrentTurnTool)
                        : s.currentTurnTools,
                    }));
                  }
                  break;
                case "tool_output":
                  if (typeof event.toolCallId === "string") {
                    const turnId = getEventTurnId(event);
                    const meta = activeToolMeta.get(event.toolCallId);
                    let nextCurrentTurnTool: ToolCall | undefined;
                    if (meta) {
                      meta.turnId = meta.turnId ?? turnId;
                      meta.progressText = event.content ?? meta.progressText;
                      const nextTool = {
                        ...meta,
                        turnId: meta.turnId ?? turnId,
                        progressText: event.content ?? meta.progressText,
                      };
                      nextCurrentTurnTool = pendingToolToToolCall(nextTool);
                      renderedActiveToolsRef.current = upsertPendingTool(renderedActiveToolsRef.current, nextTool);
                      onEntriesRef.current([createToolEntry(nextTool)]);
                    } else {
                      pendingToolPrelude.set(
                        event.toolCallId,
                        bufferPendingToolPrelude(pendingToolPrelude.get(event.toolCallId), {
                          toolCallId: event.toolCallId,
                          turnId,
                          name: getKnownToolName(event.name),
                          progressText: event.content ?? "",
                        }),
                      );
                    }
                    setStreamState((s) => ({
                      ...s,
                      activeTools: s.activeTools.map((tool) =>
                        tool.toolCallId === event.toolCallId
                          ? { ...tool, turnId: tool.turnId ?? turnId, progressText: event.content ?? tool.progressText }
                          : tool,
                      ),
                      currentTurnTools: nextCurrentTurnTool
                        ? upsertToolCall(s.currentTurnTools, nextCurrentTurnTool)
                        : s.currentTurnTools,
                    }));
                  }
                  break;
                case "tool_update": {
                  const turnId = getEventTurnId(event);
                  const meta = activeToolMeta.get(event.toolCallId as string);
                  let nextCurrentTurnTool: ToolCall | undefined;
                  if (meta) {
                    const nextTool = {
                      ...meta,
                      turnId: meta.turnId ?? turnId,
                      name: event.name ?? meta.name,
                      isSubAgent: (event.isSubAgent as boolean) ?? meta.isSubAgent,
                    };
                    meta.turnId = nextTool.turnId;
                    meta.name = nextTool.name;
                    meta.isSubAgent = nextTool.isSubAgent;
                    nextCurrentTurnTool = pendingToolToToolCall(nextTool);
                    renderedActiveToolsRef.current = upsertPendingTool(renderedActiveToolsRef.current, nextTool);
                    onEntriesRef.current([createToolEntry(nextTool)]);
                  }
                  setStreamState((s) => ({
                    ...s,
                    activeTools: s.activeTools.map((t) =>
                      t.toolCallId === event.toolCallId
                        ? { ...t, turnId: t.turnId ?? turnId, name: event.name ?? t.name, isSubAgent: event.isSubAgent ?? t.isSubAgent }
                        : t,
                    ),
                    currentTurnTools: nextCurrentTurnTool
                      ? upsertToolCall(s.currentTurnTools, nextCurrentTurnTool)
                      : s.currentTurnTools,
                  }));
                  if (!meta && typeof event.toolCallId === "string") {
                    pendingToolPrelude.set(
                      event.toolCallId,
                      bufferPendingToolPrelude(pendingToolPrelude.get(event.toolCallId), {
                        toolCallId: event.toolCallId,
                        turnId,
                        name: getKnownToolName(event.name),
                        isSubAgent: event.isSubAgent as boolean | undefined,
                      }),
                    );
                  }
                  break;
                }
                case "tool_done": {
                  const turnId = getEventTurnId(event);
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
                  const entryTurnId = meta?.turnId ?? prelude?.turnId ?? turnId;
                  onEntriesRef.current([{ type: "tool", ...(entryTurnId ? { turnId: entryTurnId } : {}), toolCall: tc }]);
                  setStreamState((s) => ({
                    ...s,
                    activeTools: s.activeTools.filter((t) => t.toolCallId !== event.toolCallId),
                    currentTurnTools: upsertToolCall(s.currentTurnTools, tc),
                    hadVisibleOutput: true,
                  }));
                  break;
                }
                case "visual_published": {
                  // Emitted by publish_visual tool handler; render inline artifact card
                  const visualEntry = createVisualEntryFromPublishedEvent(event as Record<string, unknown>);
                  if (visualEntry) onEntriesRef.current([visualEntry]);
                  break;
                }
                case "user_input_requested": {
                  const request = normalizePendingUserInputRequest(
                    event,
                    typeof event.timestamp === "string" ? event.timestamp : undefined,
                  );
                  if (!request) break;
                  setStreamState((s) => ({
                    ...s,
                    pendingUserInputs: upsertPendingUserInput(s.pendingUserInputs, request),
                    streamStatus: s.streamingContent || s.activeTools.length > 0 ? "streaming" : "thinking",
                    isStreaming: true,
                  }));
                  break;
                }
                case "user_input_answered":
                case "user_input_canceled":
                  if (typeof event.requestId === "string") {
                    setStreamState((s) => ({
                      ...s,
                      pendingUserInputs: removePendingUserInput(s.pendingUserInputs, event.requestId),
                      streamStatus: s.streamStatus === "idle" ? "thinking" : s.streamStatus,
                      isStreaming: true,
                    }));
                  }
                  break;
                case "title_changed":
                  onTitleChangedRef.current();
                  break;
                case "done":
                  activeTurnId = getEventTurnId(event);
                  emitTerminalToolEntries("done", event.timestamp);
                  if (event.content) {
                    onEntriesRef.current([{
                      role: "assistant",
                      content: event.content,
                      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
                      ...(activeTurnId ? { turnId: activeTurnId } : {}),
                    }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
                  refreshTitle(true);
                  accumulatedContent = "";
                  activeTurnId = undefined;
                  break;
                case "aborted": {
                  activeTurnId = getEventTurnId(event);
                  emitTerminalToolEntries("aborted", event.timestamp);
                  const text = event.content || accumulatedContent;
                  if (text) {
                    onEntriesRef.current([{
                      role: "assistant",
                      content: formatTerminalContent(text, "aborted"),
                      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
                      ...(activeTurnId ? { turnId: activeTurnId } : {}),
                    }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
                  accumulatedContent = "";
                  activeTurnId = undefined;
                  break;
                }
                case "shutdown": {
                  activeTurnId = getEventTurnId(event);
                  emitTerminalToolEntries("shutdown", event.timestamp);
                  const text = event.content || accumulatedContent;
                  if (text) {
                    onEntriesRef.current([{
                      role: "assistant",
                      content: formatTerminalContent(text, "shutdown"),
                      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
                      ...(activeTurnId ? { turnId: activeTurnId } : {}),
                    }]);
                  }
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
                  accumulatedContent = "";
                  activeTurnId = undefined;
                  break;
                }
                case "error":
                  activeTurnId = getEventTurnId(event);
                  emitTerminalToolEntries("error", event.timestamp);
                  onEntriesRef.current([{
                    role: "assistant",
                    content: `⚠️ Error: ${event.message}`,
                    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
                    ...(activeTurnId ? { turnId: activeTurnId } : {}),
                  }]);
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
                  activeTurnId = undefined;
                  break;
                case "mcp_status":
                  setStreamState((s) => ({ ...s, mcpServers: event.servers ?? [] }));
                  break;
                case "context_update":
                case "context_status":
                case "context": {
                  const contextSummary = getStreamContextSummary(event);
                  if (contextSummary) {
                    setStreamState((s) => ({ ...s, contextSummary }));
                  }
                  break;
                }
                case "idle":
                  setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
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
          setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
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

  const sendMessage = useCallback(async (prompt: string, attachments?: Attachment[], mode?: SendMode) => {
    if (!sessionId) return;
    const startedFromIdle = streamStateRef.current.streamStatus === "idle";
    if (startedFromIdle) {
      setStreamState((s) => mkState("sending", {
        mcpServers: s.mcpServers,
        pendingOrigin: "message",
        runMode: mode ?? s.runMode,
      }));
    }
    try {
      const response = await sendChatMessage(sessionId, prompt, attachments, mode);
      retryCountRef.current = 0;
      if (response.mode === "steered" || response.mode === "command") {
        if (startedFromIdle && sessionRef.current === sessionId) {
          connectStream(sessionId, "reconnect");
        }
        return;
      }
      connectStream(sessionId, "message", mode);
    } catch (err) {
      if (startedFromIdle) {
        setStreamState((s) => mkState("idle", { mcpServers: s.mcpServers, contextSummary: s.contextSummary }));
      }
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

  return { ...streamState, sendMessage, abortSession, reconnect };
}
