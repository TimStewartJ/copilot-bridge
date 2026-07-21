import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Attachment,
  ChatCompletionEntry,
  ChatEntry,
  ChatVisualEntry,
  ElicitationSchema,
  McpServerStatus,
  PendingElicitationRequestView,
  PendingUserInputRequestView,
  ToolArgs,
  ToolCall,
  VisualArtifact,
} from "./api";
import { API_BASE, reportTiming, sendChatMessage } from "./api";
import type { SessionContextSummary } from "../shared/session-context.js";
import type { SessionHistoryCoverage } from "../shared/session-stream.js";
import type { SendMode } from "../shared/send-mode.js";
import {
  isTerminalCompletionToolName,
  type TerminalCompletion,
  type TranscriptCompletionStatus,
} from "../shared/terminal-completion.js";

export interface PendingTool {
  toolCallId: string;
  name: string;
  turnId?: string;
  sourceEventId?: string;
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

export interface ElicitationCancellationNotice {
  requestId: string;
  question?: string;
  detail: string;
  timestamp?: string;
}

export interface StreamState {
  liveEntries: ChatEntry[];
  streamingContent: string;
  activeTools: PendingTool[];
  pendingUserInputs: PendingUserInputRequestView[];
  pendingElicitations: PendingElicitationRequestView[];
  elicitationCancellation: ElicitationCancellationNotice | null;
  currentTurnTools: ToolCall[];
  intentText: string;
  streamStatus: StreamStatus;
  isStreaming: boolean;
  hadVisibleOutput: boolean;
  mcpServers: McpServerStatus[];
  contextSummary: SessionContextSummary | null;
  pendingOrigin: PendingOrigin;
  runMode?: SendMode;
  terminalEventId?: string;
  activeTurnId?: string;
}

const VISUAL_KIND_MIME_TYPES: Record<VisualArtifact["kind"], string> = {
  image: "image/png",
  mermaid: "text/vnd.mermaid",
  "vega-lite": "application/vnd.vegalite+json",
  html: "text/html",
};

function createState(status: StreamStatus, partial: Partial<StreamState> = {}): StreamState {
  return {
    liveEntries: [],
    streamingContent: "",
    activeTools: [],
    pendingUserInputs: [],
    pendingElicitations: [],
    elicitationCancellation: null,
    currentTurnTools: [],
    intentText: "",
    hadVisibleOutput: false,
    mcpServers: [],
    contextSummary: null,
    pendingOrigin: null,
    ...partial,
    streamStatus: status,
    isStreaming: status !== "idle",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getEventTurnId(event: Record<string, unknown>): string | undefined {
  return optionalString(event.turnId);
}

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
    id: `live-visual-${event.artifactId}`,
    type: "visual",
    ...(optionalString(event.turnId) ? { turnId: optionalString(event.turnId) } : {}),
    visual,
    ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
  };
}

function getElicitationCancellationDetail(event: Record<string, unknown>): string {
  const message = typeof event.message === "string" && event.message.trim()
    ? event.message.trim()
    : undefined;
  switch (event.reason) {
    case "answered_elsewhere":
      return "This question was answered elsewhere.";
    case "superseded":
      return "This question was replaced by a newer request.";
    case "error":
      return message ?? "This question closed because the run encountered an error.";
    case "session_ended":
    default:
      return "The run ended before this question was answered.";
  }
}

function isCompletionStatus(value: unknown): value is TranscriptCompletionStatus {
  return value === "success" || value === "error";
}

function normalizeTerminalCompletion(value: unknown): TerminalCompletion | undefined {
  if (!isRecord(value) || typeof value.content !== "string" || !value.content.trim()) return undefined;
  if (typeof value.sourceEventType !== "string" || !value.sourceEventType.trim()) return undefined;
  return {
    content: value.content,
    title: typeof value.title === "string" && value.title.trim() ? value.title : "Task complete",
    status: isCompletionStatus(value.status) ? value.status : "success",
    sourceEventType: value.sourceEventType,
  };
}

function createCompletionEntry(
  completion: TerminalCompletion,
  timestamp?: string,
  turnId?: string,
  sourceEventId?: string,
): ChatCompletionEntry {
  return {
    id: sourceEventId ? `live-completion-${sourceEventId}` : undefined,
    type: "completion",
    content: completion.content,
    completion,
    ...(timestamp ? { timestamp } : {}),
    ...(turnId ? { turnId } : {}),
    ...(sourceEventId ? { sourceEventId } : {}),
  };
}

function normalizePendingUserInputRequest(
  input: unknown,
  fallbackTimestamp?: string,
): PendingUserInputRequestView | undefined {
  if (!isRecord(input) || typeof input.requestId !== "string" || typeof input.question !== "string") {
    return undefined;
  }
  return {
    requestId: input.requestId,
    question: input.question,
    allowFreeform: typeof input.allowFreeform === "boolean" ? input.allowFreeform : true,
    ...(Array.isArray(input.choices)
      ? { choices: input.choices.filter((choice): choice is string => typeof choice === "string") }
      : {}),
    ...(optionalString(input.requestedAt) ?? fallbackTimestamp
      ? { requestedAt: optionalString(input.requestedAt) ?? fallbackTimestamp }
      : {}),
    ...(optionalString(input.toolCallId) ? { toolCallId: optionalString(input.toolCallId) } : {}),
  };
}

function normalizePendingUserInputRequests(input: unknown): PendingUserInputRequestView[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((request) => {
    const normalized = normalizePendingUserInputRequest(request);
    return normalized ? [normalized] : [];
  });
}

function normalizePendingElicitationRequest(
  input: unknown,
  fallbackTimestamp?: string,
): PendingElicitationRequestView | undefined {
  if (!isRecord(input) || typeof input.requestId !== "string" || typeof input.message !== "string") {
    return undefined;
  }
  const requestedAt = optionalString(input.requestedAt) ?? fallbackTimestamp;
  const elicitationSource = optionalString(input.elicitationSource);
  if (input.mode === "url" && typeof input.url === "string") {
    return {
      requestId: input.requestId,
      message: input.message,
      mode: "url",
      url: input.url,
      ...(requestedAt ? { requestedAt } : {}),
      ...(elicitationSource ? { elicitationSource } : {}),
    };
  }
  if (input.mode === "form" && isRecord(input.requestedSchema)) {
    return {
      requestId: input.requestId,
      message: input.message,
      mode: "form",
      requestedSchema: input.requestedSchema as unknown as ElicitationSchema,
      ...(requestedAt ? { requestedAt } : {}),
      ...(elicitationSource ? { elicitationSource } : {}),
    };
  }
  return undefined;
}

function normalizePendingElicitationRequests(input: unknown): PendingElicitationRequestView[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((request) => {
    const normalized = normalizePendingElicitationRequest(request);
    return normalized ? [normalized] : [];
  });
}

function upsertByRequestId<T extends { requestId: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.requestId === next.requestId);
  if (index < 0) return [...items, next];
  return items.map((item, currentIndex) => currentIndex === index ? next : item);
}

function removeByRequestId<T extends { requestId: string }>(items: T[], requestId: string): T[] {
  return items.filter((item) => item.requestId !== requestId);
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

export function materializePendingTool<
  T extends Pick<PendingTool, "name" | "progressText" | "isSubAgent"> & { turnId?: string }
>(tool: T, prelude?: PendingToolPrelude): T {
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
  const collected = new Map<string, PendingTool>();
  const merge = (tool: PendingTool) => {
    const existing = collected.get(tool.toolCallId);
    collected.set(tool.toolCallId, {
      ...existing,
      ...tool,
      name: getKnownToolName(tool.name) ?? getKnownToolName(existing?.name) ?? tool.name,
      args: tool.args ?? existing?.args,
      parentToolCallId: tool.parentToolCallId ?? existing?.parentToolCallId,
      isSubAgent: tool.isSubAgent ?? existing?.isSubAgent,
      turnId: tool.turnId ?? existing?.turnId,
      sourceEventId: existing?.sourceEventId ?? tool.sourceEventId,
      startedAt: tool.startedAt ?? existing?.startedAt,
      progressText: tool.progressText ?? existing?.progressText,
    });
  };
  for (const tool of renderedTools) merge(tool);
  for (const tool of activeTools) merge(tool);
  for (const prelude of preludes) {
    merge(materializePendingTool({
      toolCallId: prelude.toolCallId,
      name: resolvePendingToolName(undefined, prelude),
      turnId: prelude.turnId,
    }, prelude));
  }
  return [...collected.values()];
}

function isHiddenTool(name: string, args: ToolArgs | undefined, sessionId: string): boolean {
  if (isTerminalCompletionToolName(name) || name === "report_intent") return true;
  if (name !== "session_rename") return false;
  if (!args || typeof args !== "object") return true;
  const targetSessionId = (args as Record<string, unknown>).sessionId;
  return typeof targetSessionId !== "string" || targetSessionId === sessionId;
}

function normalizeSnapshotTool(rawTool: unknown, activeTurnId: string | undefined): SnapshotTool | undefined {
  if (!isRecord(rawTool)) return undefined;
  return {
    toolCallId: optionalString(rawTool.toolCallId) ?? "",
    name: optionalString(rawTool.name) ?? "unknown",
    turnId: optionalString(rawTool.turnId) ?? activeTurnId,
    sourceEventId: optionalString(rawTool.sourceEventId),
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

function mergeSnapshotTool(existing: SnapshotTool, next: SnapshotTool): SnapshotTool {
  return {
    ...existing,
    ...next,
    toolCallId: existing.toolCallId,
    name: getKnownToolName(next.name) ?? getKnownToolName(existing.name) ?? next.name,
    turnId: next.turnId ?? existing.turnId,
    sourceEventId: existing.sourceEventId ?? next.sourceEventId,
    args: next.args ?? existing.args,
    parentToolCallId: next.parentToolCallId ?? existing.parentToolCallId,
    isSubAgent: next.isSubAgent ?? existing.isSubAgent,
    startedAt: next.startedAt ?? existing.startedAt,
    progressText: next.progressText ?? existing.progressText,
    result: next.result ?? existing.result,
    success: next.success ?? existing.success,
    completedAt: next.completedAt ?? existing.completedAt,
  };
}

function normalizeSnapshotTools(rawTools: unknown, activeTurnId: string | undefined, sessionId: string): SnapshotTool[] {
  if (!Array.isArray(rawTools)) return [];
  const tools = new Map<string, SnapshotTool>();
  for (const rawTool of rawTools) {
    const tool = normalizeSnapshotTool(rawTool, activeTurnId);
    if (!tool?.toolCallId || isHiddenTool(tool.name, tool.args, sessionId)) continue;
    const existing = tools.get(tool.toolCallId);
    tools.set(tool.toolCallId, existing ? mergeSnapshotTool(existing, tool) : tool);
  }
  return [...tools.values()];
}

function pendingToolToToolCall(tool: PendingTool, partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: tool.toolCallId,
    name: tool.name,
    turnId: tool.turnId,
    sourceEventId: tool.sourceEventId,
    args: tool.args,
    parentToolCallId: tool.parentToolCallId,
    isSubAgent: tool.isSubAgent,
    startedAt: tool.startedAt,
    progressText: tool.progressText,
    ...partial,
  };
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
  const activeTurnId = typeof event.turnId === "string" ? event.turnId : undefined;
  const activeTools = normalizeSnapshotTools(event.activeTools, activeTurnId, sessionId);
  const allTools = normalizeSnapshotTools(
    Array.isArray(event.currentTurnTools) ? event.currentTurnTools : event.activeTools,
    activeTurnId,
    sessionId,
  );
  return {
    activeTools,
    currentTurnTools: allTools.map(snapshotToolToToolCall),
    toolEntries: allTools.map((tool) => ({
      id: `live-tool-${tool.toolCallId}`,
      type: "tool",
      turnId: tool.turnId,
      sourceEventId: tool.sourceEventId,
      toolCall: snapshotToolToToolCall(tool),
    })),
  };
}

export function buildTerminalToolEntries(
  tools: PendingTool[],
  terminalType: "done" | "error" | "aborted" | "shutdown",
  completedAt?: string,
): ChatEntry[] {
  return tools.map((tool) => ({
    id: `live-tool-${tool.toolCallId}`,
    type: "tool",
    turnId: tool.turnId,
    sourceEventId: tool.sourceEventId,
    toolCall: pendingToolToToolCall(tool, {
      success: terminalType === "done",
      ...(completedAt ? { completedAt } : {}),
    }),
  }));
}

function normalizeStreamContextSummary(value: unknown): SessionContextSummary | null {
  if (!isRecord(value)) return null;
  const summary = isRecord(value.summary) ? value.summary : value;
  return summary as unknown as SessionContextSummary;
}

function getStreamContextSummary(event: Record<string, unknown>): SessionContextSummary | null {
  return normalizeStreamContextSummary(event.summary)
    ?? normalizeStreamContextSummary(event.contextSummary)
    ?? normalizeStreamContextSummary(isRecord(event.context) ? event.context.summary : undefined)
    ?? normalizeStreamContextSummary(event.context);
}

function formatTerminalContent(content: string, terminalType?: string): string {
  if (terminalType === "aborted") return `${content}\n\n*(stopped)*`;
  if (terminalType === "shutdown") return `${content}\n\n*(interrupted)*`;
  return content;
}

function createAssistantEntry(
  content: string,
  options: {
    id: string;
    turnId?: string;
    sourceEventId?: string;
    timestamp?: string;
    terminalType?: string;
  },
): ChatEntry {
  return {
    id: options.id,
    type: "message",
    role: "assistant",
    content: formatTerminalContent(content, options.terminalType),
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.sourceEventId ? { sourceEventId: options.sourceEventId } : {}),
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
  };
}

function buildSnapshotLiveEntries(event: Record<string, unknown>, sessionId: string): ChatEntry[] {
  const turnId = getEventTurnId(event);
  const entriesByKey = new Map<string, ChatEntry>();
  if (Array.isArray(event.assistantSegments)) {
    for (const rawSegment of event.assistantSegments) {
      if (!isRecord(rawSegment) || typeof rawSegment.id !== "string" || typeof rawSegment.content !== "string") continue;
      entriesByKey.set(`assistant:${rawSegment.id}`, createAssistantEntry(rawSegment.content, {
        id: `live-assistant-${rawSegment.id}`,
        turnId: optionalString(rawSegment.turnId) ?? turnId,
        sourceEventId: optionalString(rawSegment.sourceEventId),
        timestamp: optionalString(rawSegment.timestamp),
      }));
    }
  }

  const toolState = buildSnapshotToolState(event, sessionId);
  for (const entry of toolState.toolEntries) {
    if (entry.type === "tool") entriesByKey.set(`tool:${entry.toolCall.toolCallId}`, entry);
  }

  if (Array.isArray(event.visuals)) {
    for (const rawVisual of event.visuals) {
      if (!isRecord(rawVisual)) continue;
      const entry = createVisualEntryFromPublishedEvent(rawVisual);
      if (entry) entriesByKey.set(`visual:${entry.visual.artifactId}`, entry);
    }
  }

  const result: ChatEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(event.entryOrder)) {
    for (const rawKey of event.entryOrder) {
      if (typeof rawKey !== "string") continue;
      const entry = entriesByKey.get(rawKey);
      if (!entry) continue;
      result.push(entry);
      seen.add(rawKey);
    }
  }
  for (const [key, entry] of entriesByKey) {
    if (!seen.has(key)) result.push(entry);
  }

  if (!event.complete) return result;
  const sourceEventId = optionalString(event.terminalEventId);
  const timestamp = optionalString(event.terminalTimestamp);
  const completion = normalizeTerminalCompletion(event.terminalCompletion);
  if (completion) {
    result.push(createCompletionEntry(completion, timestamp, turnId, sourceEventId));
  } else if (typeof event.finalContent === "string" && event.finalContent) {
    result.push(createAssistantEntry(event.finalContent, {
      id: sourceEventId ? `live-terminal-${sourceEventId}` : `live-terminal-${optionalString(event.runId) ?? "synthetic"}`,
      turnId,
      sourceEventId,
      timestamp,
      terminalType: optionalString(event.terminalType),
    }));
  } else if (typeof event.errorMessage === "string" && event.errorMessage) {
    result.push(createAssistantEntry(`⚠️ Error: ${event.errorMessage}`, {
      id: sourceEventId ? `live-terminal-${sourceEventId}` : `live-terminal-${optionalString(event.runId) ?? "synthetic"}`,
      turnId,
      sourceEventId,
      timestamp,
    }));
  }
  return result;
}

function upsertTool(tools: ToolCall[], next: ToolCall): ToolCall[] {
  const index = tools.findIndex((tool) => tool.toolCallId === next.toolCallId);
  if (index < 0) return [...tools, next];
  return tools.map((tool, currentIndex) => currentIndex === index
    ? {
        ...tool,
        ...next,
        toolCallId: tool.toolCallId,
        name: getKnownToolName(next.name) ?? getKnownToolName(tool.name) ?? next.name,
        sourceEventId: tool.sourceEventId ?? next.sourceEventId,
        args: next.args ?? tool.args,
        result: next.result ?? tool.result,
        progressText: next.progressText ?? tool.progressText,
        success: next.success ?? tool.success,
        parentToolCallId: next.parentToolCallId ?? tool.parentToolCallId,
        isSubAgent: next.isSubAgent ?? tool.isSubAgent,
        startedAt: next.startedAt ?? tool.startedAt,
        completedAt: next.completedAt ?? tool.completedAt,
      }
    : tool);
}

function upsertLiveToolEntry(entries: ChatEntry[], tool: ToolCall): ChatEntry[] {
  const next: ChatEntry = {
    id: `live-tool-${tool.toolCallId}`,
    type: "tool",
    turnId: tool.turnId,
    sourceEventId: tool.sourceEventId,
    toolCall: tool,
  };
  const index = entries.findIndex((entry) => entry.type === "tool" && entry.toolCall.toolCallId === tool.toolCallId);
  if (index < 0) return [...entries, next];
  return entries.map((entry, currentIndex) => currentIndex === index ? next : entry);
}

function appendUniqueEntry(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  if (entry.id && entries.some((candidate) => candidate.id === entry.id)) return entries;
  return [...entries, entry];
}

export function useSessionStream(
  sessionId: string | null,
  onSettled: () => void,
  onTitleChanged: () => void,
  historyCoverage?: SessionHistoryCoverage,
) {
  const [streamState, setStreamState] = useState<StreamState>(() => createState("idle"));
  const streamStateRef = useRef(streamState);
  streamStateRef.current = streamState;
  const sessionRef = useRef<string | null>(sessionId);
  const eventSourceRef = useRef<EventSource | null>(null);
  const generationRef = useRef(0);
  const entryCounterRef = useRef(0);
  const preludesRef = useRef(new Map<string, PendingToolPrelude>());
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const onTitleChangedRef = useRef(onTitleChanged);
  onTitleChangedRef.current = onTitleChanged;

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const connectStream = useCallback((
    sid: string,
    pendingOrigin: PendingOrigin = "reconnect",
    runMode?: SendMode,
  ) => {
    closeStream();
    const generation = ++generationRef.current;
    preludesRef.current.clear();
    if (pendingOrigin === "message") entryCounterRef.current = 0;
    setStreamState((current) => createState("sending", {
      liveEntries: pendingOrigin === "reconnect" ? current.liveEntries : [],
      mcpServers: current.mcpServers,
      contextSummary: current.contextSummary,
      elicitationCancellation: pendingOrigin === "reconnect" ? current.elicitationCancellation : null,
      pendingUserInputs: pendingOrigin === "reconnect" ? current.pendingUserInputs : [],
      pendingElicitations: pendingOrigin === "reconnect" ? current.pendingElicitations : [],
      currentTurnTools: pendingOrigin === "reconnect" ? current.currentTurnTools : [],
      activeTools: pendingOrigin === "reconnect" ? current.activeTools : [],
      streamingContent: pendingOrigin === "reconnect" ? current.streamingContent : "",
      pendingOrigin,
      runMode: runMode ?? current.runMode,
    }));

    const source = new EventSource(`${API_BASE}/api/sessions/${encodeURIComponent(sid)}/stream`);
    eventSourceRef.current = source;
    const isCurrent = () => generation === generationRef.current && sid === sessionRef.current;
    const closeCurrent = () => {
      if (eventSourceRef.current === source) eventSourceRef.current = null;
      source.close();
    };
    const report = (name: string, metadata?: Record<string, unknown>) => {
      void reportTiming(name, 0, { sessionId: sid, metadata });
    };

    source.onopen = () => {
      if (!isCurrent()) {
        source.close();
        return;
      }
      report("stream.connected", { pendingOrigin });
    };

    source.onerror = () => {
      if (!isCurrent()) return;
      report("stream.disconnected", { readyState: source.readyState });
      if (source.readyState === EventSource.CLOSED) {
        closeCurrent();
        setStreamState((current) => createState("idle", {
          liveEntries: current.liveEntries,
          mcpServers: current.mcpServers,
          contextSummary: current.contextSummary,
          elicitationCancellation: current.elicitationCancellation,
        }));
        onSettledRef.current();
      }
    };

    source.onmessage = (message) => {
      if (!isCurrent()) return;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(message.data);
        if (!isRecord(parsed) || typeof parsed.type !== "string") throw new Error("Invalid stream event");
        event = parsed;
      } catch (error) {
        report("stream.parse_error", {
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const eventType = event.type as string;
      if (eventType === "snapshot") {
        const toolState = buildSnapshotToolState(event, sid);
        const liveEntries = buildSnapshotLiveEntries(event, sid);
        const contextSummary = getStreamContextSummary(event);
        const complete = event.complete === true;
        if (complete) closeCurrent();
        setStreamState((current) => complete
          ? createState("idle", {
              liveEntries,
              mcpServers: Array.isArray(event.mcpServers)
                ? event.mcpServers as McpServerStatus[]
                : current.mcpServers,
              contextSummary: contextSummary ?? current.contextSummary,
              elicitationCancellation: current.elicitationCancellation,
              terminalEventId: optionalString(event.terminalEventId),
              hadVisibleOutput: liveEntries.length > 0,
              activeTurnId: getEventTurnId(event),
            })
          : {
              ...current,
              liveEntries,
              streamingContent: optionalString(event.accumulatedContent) ?? "",
              activeTools: toolState.activeTools,
              currentTurnTools: toolState.currentTurnTools,
              pendingUserInputs: normalizePendingUserInputRequests(event.pendingUserInputs),
              pendingElicitations: normalizePendingElicitationRequests(event.pendingElicitations),
              intentText: optionalString(event.intentText) ?? "",
              mcpServers: Array.isArray(event.mcpServers)
                ? event.mcpServers as McpServerStatus[]
                : current.mcpServers,
              contextSummary: contextSummary ?? current.contextSummary,
              streamStatus: liveEntries.length > 0 || event.accumulatedContent ? "streaming" : "thinking",
              isStreaming: true,
              hadVisibleOutput: liveEntries.length > 0 || Boolean(event.accumulatedContent),
              terminalEventId: undefined,
              activeTurnId: getEventTurnId(event),
            });
        if (complete) {
          report("stream.terminal", { terminalType: event.terminalType, source: "snapshot" });
          onSettledRef.current();
          if (event.terminalType === "done") onTitleChangedRef.current();
        }
        return;
      }

      if (eventType === "resync_required" || eventType === "idle") {
        closeCurrent();
        setStreamState((current) => createState("idle", {
          mcpServers: current.mcpServers,
          contextSummary: current.contextSummary,
          elicitationCancellation: current.elicitationCancellation,
        }));
        report("stream.resync_required");
        onSettledRef.current();
        return;
      }

      if (eventType === "thinking") {
        setStreamState((current) => ({
          ...current,
          streamStatus: "thinking",
          isStreaming: true,
          activeTurnId: getEventTurnId(event) ?? current.activeTurnId,
        }));
        return;
      }
      if (eventType === "intent") {
        setStreamState((current) => ({ ...current, intentText: optionalString(event.intent) ?? "" }));
        return;
      }
      if (eventType === "delta") {
        const content = optionalString(event.content) ?? "";
        setStreamState((current) => ({
          ...current,
          streamingContent: current.streamingContent + content,
          streamStatus: "streaming",
          isStreaming: true,
          hadVisibleOutput: true,
          activeTurnId: getEventTurnId(event) ?? current.activeTurnId,
        }));
        return;
      }
      if (eventType === "assistant_partial") {
        setStreamState((current) => {
          const content = optionalString(event.content) ?? current.streamingContent;
          if (!content) return { ...current, streamingContent: "" };
          const sourceEventId = optionalString(event.sourceEventId);
          const id = sourceEventId ?? `synthetic-${generation}-${++entryCounterRef.current}`;
          return {
            ...current,
            liveEntries: appendUniqueEntry(current.liveEntries, createAssistantEntry(content, {
              id: `live-assistant-${id}`,
              turnId: getEventTurnId(event),
              sourceEventId,
              timestamp: optionalString(event.timestamp),
            })),
            streamingContent: "",
            hadVisibleOutput: true,
            activeTurnId: getEventTurnId(event) ?? current.activeTurnId,
          };
        });
        return;
      }
      if (eventType === "tool_start") {
        setStreamState((current) => {
          const toolCallId = optionalString(event.toolCallId);
          if (!toolCallId) return current;
          const prelude = preludesRef.current.get(toolCallId);
          preludesRef.current.delete(toolCallId);
          const pending = materializePendingTool<PendingTool>({
            toolCallId,
            name: resolvePendingToolName(event.name, prelude),
            turnId: getEventTurnId(event) ?? prelude?.turnId,
            sourceEventId: optionalString(event.sourceEventId),
            args: event.args as ToolArgs | undefined,
            parentToolCallId: optionalString(event.parentToolCallId),
            isSubAgent: optionalBoolean(event.isSubAgent),
            startedAt: optionalString(event.timestamp),
          }, prelude);
          if (isHiddenTool(pending.name, pending.args, sid)) return current;
          const tool = pendingToolToToolCall(pending);
          return {
            ...current,
            activeTools: upsertByTool(current.activeTools, pending),
            currentTurnTools: upsertTool(current.currentTurnTools, tool),
            liveEntries: upsertLiveToolEntry(current.liveEntries, tool),
            streamStatus: "streaming",
            isStreaming: true,
            hadVisibleOutput: true,
          };
        });
        return;
      }
      if (eventType === "tool_progress" || eventType === "tool_output" || eventType === "tool_update") {
        const toolCallId = optionalString(event.toolCallId);
        if (!toolCallId) return;
        setStreamState((current) => {
          const existing = current.currentTurnTools.find((tool) => tool.toolCallId === toolCallId);
          if (!existing) {
            preludesRef.current.set(toolCallId, bufferPendingToolPrelude(preludesRef.current.get(toolCallId), {
              toolCallId,
              turnId: getEventTurnId(event),
              name: getKnownToolName(event.name),
              progressText: optionalString(eventType === "tool_output" ? event.content : event.message),
              isSubAgent: optionalBoolean(event.isSubAgent),
            }));
            return current;
          }
          const next: ToolCall = {
            ...existing,
            turnId: existing.turnId ?? getEventTurnId(event),
            name: getKnownToolName(event.name) ?? existing.name,
            progressText: optionalString(eventType === "tool_output" ? event.content : event.message)
              ?? existing.progressText,
            isSubAgent: optionalBoolean(event.isSubAgent) ?? existing.isSubAgent,
          };
          return {
            ...current,
            activeTools: current.activeTools.map((tool) => tool.toolCallId === toolCallId
              ? {
                  ...tool,
                  turnId: tool.turnId ?? next.turnId,
                  name: next.name,
                  progressText: next.progressText,
                  isSubAgent: next.isSubAgent,
                }
              : tool),
            currentTurnTools: upsertTool(current.currentTurnTools, next),
            liveEntries: upsertLiveToolEntry(current.liveEntries, next),
          };
        });
        return;
      }
      if (eventType === "tool_done") {
        const toolCallId = optionalString(event.toolCallId);
        if (!toolCallId) return;
        setStreamState((current) => {
          const existing = current.currentTurnTools.find((tool) => tool.toolCallId === toolCallId);
          const prelude = preludesRef.current.get(toolCallId);
          preludesRef.current.delete(toolCallId);
          const name = existing?.name ?? resolvePendingToolName(event.name, prelude);
          if (isHiddenTool(name, existing?.args, sid)) return current;
          const next: ToolCall = {
            toolCallId,
            name,
            turnId: existing?.turnId ?? prelude?.turnId ?? getEventTurnId(event),
            sourceEventId: existing?.sourceEventId ?? optionalString(event.sourceEventId),
            args: existing?.args,
            result: optionalString(event.result),
            progressText: existing?.progressText ?? prelude?.progressText,
            success: optionalBoolean(event.success),
            parentToolCallId: existing?.parentToolCallId ?? optionalString(event.parentToolCallId),
            isSubAgent: existing?.isSubAgent ?? prelude?.isSubAgent ?? optionalBoolean(event.isSubAgent),
            startedAt: existing?.startedAt,
            completedAt: optionalString(event.timestamp),
          };
          return {
            ...current,
            activeTools: current.activeTools.filter((tool) => tool.toolCallId !== toolCallId),
            currentTurnTools: upsertTool(current.currentTurnTools, next),
            liveEntries: upsertLiveToolEntry(current.liveEntries, next),
            hadVisibleOutput: true,
          };
        });
        return;
      }
      if (eventType === "visual_published") {
        const entry = createVisualEntryFromPublishedEvent(event);
        if (entry) {
          setStreamState((current) => ({
            ...current,
            liveEntries: appendUniqueEntry(current.liveEntries, entry),
            hadVisibleOutput: true,
          }));
        }
        return;
      }
      if (eventType === "user_input_requested") {
        const request = normalizePendingUserInputRequest(event, optionalString(event.timestamp));
        if (request) setStreamState((current) => ({
          ...current,
          pendingUserInputs: upsertByRequestId(current.pendingUserInputs, request),
          streamStatus: current.streamingContent || current.activeTools.length > 0 ? "streaming" : "thinking",
          isStreaming: true,
        }));
        return;
      }
      if (eventType === "user_input_answered" || eventType === "user_input_canceled") {
        const requestId = optionalString(event.requestId);
        if (requestId) setStreamState((current) => ({
          ...current,
          pendingUserInputs: removeByRequestId(current.pendingUserInputs, requestId),
        }));
        return;
      }
      if (eventType === "elicitation_requested") {
        const request = normalizePendingElicitationRequest(event, optionalString(event.timestamp));
        if (request) setStreamState((current) => ({
          ...current,
          pendingElicitations: upsertByRequestId(current.pendingElicitations, request),
          elicitationCancellation: null,
          streamStatus: current.streamingContent || current.activeTools.length > 0 ? "streaming" : "thinking",
          isStreaming: true,
        }));
        return;
      }
      if (eventType === "elicitation_resolved") {
        const requestId = optionalString(event.requestId);
        if (requestId) setStreamState((current) => ({
          ...current,
          pendingElicitations: removeByRequestId(current.pendingElicitations, requestId),
        }));
        return;
      }
      if (eventType === "elicitation_canceled") {
        const requestId = optionalString(event.requestId);
        if (requestId) setStreamState((current) => {
          const request = current.pendingElicitations.find((candidate) => candidate.requestId === requestId);
          return {
            ...current,
            pendingElicitations: removeByRequestId(current.pendingElicitations, requestId),
            elicitationCancellation: {
              requestId,
              ...(request?.message ? { question: request.message } : {}),
              detail: getElicitationCancellationDetail(event),
              ...(optionalString(event.timestamp) ? { timestamp: optionalString(event.timestamp) } : {}),
            },
          };
        });
        return;
      }
      if (eventType === "title_changed") {
        onTitleChangedRef.current();
        return;
      }
      if (eventType === "mcp_status") {
        setStreamState((current) => ({
          ...current,
          mcpServers: Array.isArray(event.servers) ? event.servers as McpServerStatus[] : [],
        }));
        return;
      }
      if (eventType === "context_update" || eventType === "context_status" || eventType === "context") {
        const summary = getStreamContextSummary(event);
        if (summary) setStreamState((current) => ({ ...current, contextSummary: summary }));
        return;
      }
      if (eventType === "history_truncated") {
        onSettledRef.current();
        return;
      }
      if (eventType === "done" || eventType === "error" || eventType === "aborted" || eventType === "shutdown") {
        closeCurrent();
        const sourceEventId = optionalString(event.sourceEventId);
        setStreamState((current) => {
          let liveEntries = current.liveEntries;
          const completedAt = optionalString(event.timestamp);
          const finalizedTools = current.currentTurnTools.map((tool) => ({
            ...tool,
            success: tool.success ?? eventType === "done",
            completedAt: tool.completedAt ?? completedAt,
          }));
          for (const tool of finalizedTools) liveEntries = upsertLiveToolEntry(liveEntries, tool);
          const completion = normalizeTerminalCompletion(event.terminalCompletion);
          if (completion) {
            liveEntries = appendUniqueEntry(liveEntries, createCompletionEntry(
              completion,
              completedAt,
              getEventTurnId(event),
              sourceEventId,
            ));
          } else {
            const content = eventType === "error"
              ? `⚠️ Error: ${optionalString(event.message) ?? "Unknown session error"}`
              : optionalString(event.content) ?? current.streamingContent;
            if (content) {
              liveEntries = appendUniqueEntry(liveEntries, createAssistantEntry(content, {
                id: sourceEventId
                  ? `live-terminal-${sourceEventId}`
                  : `live-terminal-synthetic-${generation}`,
                turnId: getEventTurnId(event),
                sourceEventId,
                timestamp: completedAt,
                terminalType: eventType,
              }));
            }
          }
          return createState("idle", {
            liveEntries,
            currentTurnTools: finalizedTools,
            mcpServers: current.mcpServers,
            contextSummary: current.contextSummary,
            elicitationCancellation: current.elicitationCancellation,
            terminalEventId: sourceEventId,
            hadVisibleOutput: liveEntries.length > 0,
            activeTurnId: getEventTurnId(event) ?? current.activeTurnId,
          });
        });
        report("stream.terminal", { terminalType: eventType, source: "event" });
        onSettledRef.current();
        if (eventType === "done") onTitleChangedRef.current();
      }
    };
  }, [closeStream]);

  useEffect(() => {
    sessionRef.current = sessionId;
    generationRef.current += 1;
    closeStream();
    preludesRef.current.clear();
    setStreamState(createState("idle"));
    return closeStream;
  }, [closeStream, sessionId]);

  useEffect(() => {
    const terminalEventId = streamStateRef.current.terminalEventId;
    if (!terminalEventId || historyCoverage?.latestTerminalEventId !== terminalEventId) return;
    setStreamState((current) => current.terminalEventId === terminalEventId
      ? createState("idle", {
          mcpServers: current.mcpServers,
          contextSummary: current.contextSummary,
          elicitationCancellation: current.elicitationCancellation,
        })
      : current);
  }, [historyCoverage?.latestTerminalEventId]);

  const sendMessage = useCallback(async (prompt: string, attachments?: Attachment[], mode?: SendMode) => {
    if (!sessionId) return;
    const startedFromIdle = streamStateRef.current.streamStatus === "idle";
    if (startedFromIdle) {
      setStreamState((current) => createState("sending", {
        mcpServers: current.mcpServers,
        contextSummary: current.contextSummary,
        pendingOrigin: "message",
        runMode: mode ?? current.runMode,
      }));
    }
    try {
      const response = await sendChatMessage(sessionId, prompt, attachments, mode);
      if (response.mode === "steered" || response.mode === "command") {
        if (startedFromIdle && sessionRef.current === sessionId) connectStream(sessionId, "reconnect");
        return;
      }
      if (sessionRef.current === sessionId) {
        connectStream(sessionId, "message", mode);
      }
    } catch (error) {
      if (startedFromIdle && sessionRef.current === sessionId) {
        setStreamState((current) => createState("idle", {
          mcpServers: current.mcpServers,
          contextSummary: current.contextSummary,
        }));
      }
      throw error;
    }
  }, [connectStream, sessionId]);

  const abortSession = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Abort failed with status ${response.status}`);
    }
  }, [sessionId]);

  const reconnect = useCallback((sid: string) => {
    connectStream(sid, "reconnect");
  }, [connectStream]);

  return { ...streamState, sendMessage, abortSession, reconnect };
}

function upsertByTool(tools: PendingTool[], next: PendingTool): PendingTool[] {
  const index = tools.findIndex((tool) => tool.toolCallId === next.toolCallId);
  if (index < 0) return [...tools, next];
  return tools.map((tool, currentIndex) => currentIndex === index
    ? {
        ...tool,
        ...next,
        sourceEventId: tool.sourceEventId ?? next.sourceEventId,
        toolCallId: tool.toolCallId,
      }
    : tool);
}
