import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Attachment,
  ElicitationSchema,
  McpServerStatus,
  PendingElicitationRequestView,
  PendingUserInputRequestView,
  ToolArgs,
} from "./api";
import { API_BASE, reportTiming, sendChatMessage } from "./api";
import type { SessionContextSummary } from "../shared/session-context.js";
import type { SendMode } from "../shared/send-mode.js";
import type { RunNotice } from "../shared/session-stream.js";
import type { TerminalCompletion } from "../shared/terminal-completion.js";
import { isHiddenTool } from "../shared/tool-visibility.js";
import { isRecord } from "../shared/is-record.js";

/**
 * Live stream state.
 *
 * `events.jsonl` (served by `/messages-fast`) is the sole authority for committed transcript
 * content and ordering. This hook only carries state that is genuinely not on disk yet:
 * streaming text, in-flight tools, accepted-but-unpersisted prompts, pending interactions, and
 * bridge-native run notices. Everything disk-backed here carries the `sourceEventId` it will be
 * committed under, so the view can hand it off to history by exact identity instead of merging.
 */

/**
 * A tool call known to the stream, including recently-completed ones. The view substitutes this
 * state onto the matching disk entry (matched by `toolCallId`) rather than appending a duplicate,
 * so `events.jsonl` keeps deciding where the tool sits in the transcript.
 */
export interface PendingTool {
  toolCallId: string;
  name: string;
  turnId?: string;
  turnInstanceId?: string;
  sourceEventId?: string;
  args?: ToolArgs;
  parentToolCallId?: string;
  isSubAgent?: boolean;
  startedAt?: string;
  progressText?: string;
  completedAt?: string;
  success?: boolean;
  result?: string;
}

/** A visual published this run, retired once its `artifactId` appears in loaded disk history. */
export interface LiveVisual {
  artifactId: string;
  kind?: string;
  title?: string;
  displayName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  downloadUrl?: string;
  source?: string;
  caption?: string;
  altText?: string;
  timestamp?: string;
  turnId?: string;
  turnInstanceId?: string;
}

/** A completion card for this run, retired once its source event appears in disk history. */
export interface LiveCompletion {
  completion: TerminalCompletion;
  sourceEventId?: string;
  timestamp?: string;
  turnId?: string;
  turnInstanceId?: string;
}

/**
 * Assistant text that has not been observed in loaded disk history yet. A segment with a
 * `sourceEventId` is disk-backed and is dropped once that id appears in history; a segment without
 * one is bridge-native (slash-command output) and has no disk representation at all.
 */
export interface LiveAssistantSegment {
  id: string;
  content: string;
  sourceEventId?: string;
  /** Bridge-produced text with no events.jsonl representation; never handed off to history. */
  bridgeNative?: boolean;
  turnId?: string;
  turnInstanceId?: string;
  timestamp?: string;
}

/** An accepted prompt held until its persisted `sourceEventId` appears in loaded history. */
export interface LivePendingUserMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  sourceEventId?: string;
  timestamp?: string;
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
  streamingContent: string;
  liveAssistantSegments: LiveAssistantSegment[];
  pendingUserMessages: LivePendingUserMessage[];
  /** In-flight and recently-completed tools; the view derives in-flight ones for run status. */
  liveTools: PendingTool[];
  liveVisuals: LiveVisual[];
  liveCompletion: LiveCompletion | null;
  pendingUserInputs: PendingUserInputRequestView[];
  pendingElicitations: PendingElicitationRequestView[];
  elicitationCancellation: ElicitationCancellationNotice | null;
  runNotice: RunNotice | null;
  intentText: string;
  streamStatus: StreamStatus;
  isStreaming: boolean;
  hadVisibleOutput: boolean;
  contextSummary: SessionContextSummary | null;
  pendingOrigin: PendingOrigin;
  runMode?: SendMode;
  activeTurnId?: string;
  activeTurnInstanceId?: string;
  /**
   * Locally monotonic marker that advances whenever committed disk history may have changed.
   * Derived rather than mirrored: the server's per-run counter restarts with each new bus, so the
   * view would otherwise stop refreshing after the first run of a session.
   */
  historyEpoch: number;
}

function createState(status: StreamStatus, partial: Partial<StreamState> = {}): StreamState {
  return {
    streamingContent: "",
    liveAssistantSegments: [],
    pendingUserMessages: [],
    liveTools: [],
    liveVisuals: [],
    liveCompletion: null,
    pendingUserInputs: [],
    pendingElicitations: [],
    elicitationCancellation: null,
    runNotice: null,
    intentText: "",
    hadVisibleOutput: false,
    contextSummary: null,
    pendingOrigin: null,
    historyEpoch: 0,
    ...partial,
    streamStatus: status,
    isStreaming: status !== "idle",
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const MCP_SERVER_STATUSES = new Set<McpServerStatus["status"]>([
  "connected", "failed", "needs-auth", "pending", "disabled", "not_configured", "unknown",
]);

function normalizeMcpServerStatuses(value: unknown): McpServerStatus[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) return [];
    const status = typeof entry.status === "string"
      && MCP_SERVER_STATUSES.has(entry.status as McpServerStatus["status"])
      ? entry.status as McpServerStatus["status"]
      : "unknown";
    return [{
      name: entry.name,
      status,
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
    }];
  });
}

function getEventTurnId(event: Record<string, unknown>): string | undefined {
  return optionalString(event.turnId);
}

function getEventTurnInstanceId(event: Record<string, unknown>): string | undefined {
  return optionalString(event.turnInstanceId);
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

export function normalizeRunNotice(value: unknown): RunNotice | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind !== "stopped" && kind !== "interrupted" && kind !== "error" && kind !== "command") {
    return null;
  }
  return {
    kind,
    ...(optionalString(value.content) ? { content: optionalString(value.content) } : {}),
    ...(optionalString(value.message) ? { message: optionalString(value.message) } : {}),
    ...(optionalString(value.timestamp) ? { timestamp: optionalString(value.timestamp) } : {}),
  };
}

export function normalizeLiveAssistantSegment(value: unknown): LiveAssistantSegment | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.content !== "string") {
    return undefined;
  }
  if (!value.content) return undefined;
  return {
    id: value.id,
    content: value.content,
    ...(optionalString(value.sourceEventId) ? { sourceEventId: optionalString(value.sourceEventId) } : {}),
    ...(value.bridgeNative === true ? { bridgeNative: true } : {}),
    ...(optionalString(value.turnId) ? { turnId: optionalString(value.turnId) } : {}),
    ...(optionalString(value.turnInstanceId)
      ? { turnInstanceId: optionalString(value.turnInstanceId) }
      : {}),
    ...(optionalString(value.timestamp) ? { timestamp: optionalString(value.timestamp) } : {}),
  };
}

function normalizeLiveAssistantSegments(value: unknown): LiveAssistantSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((segment) => {
    const normalized = normalizeLiveAssistantSegment(segment);
    return normalized ? [normalized] : [];
  });
}

export function normalizePendingUserMessage(value: unknown): LivePendingUserMessage | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.content !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    content: value.content,
    ...(Array.isArray(value.attachments) ? { attachments: value.attachments as Attachment[] } : {}),
    ...(optionalString(value.sourceEventId) ? { sourceEventId: optionalString(value.sourceEventId) } : {}),
    ...(optionalString(value.timestamp) ? { timestamp: optionalString(value.timestamp) } : {}),
  };
}

function normalizePendingUserMessages(value: unknown): LivePendingUserMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const normalized = normalizePendingUserMessage(message);
    return normalized ? [normalized] : [];
  });
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

export function normalizeActiveTool(
  rawTool: unknown,
  fallbackTurnId?: string,
  fallbackTurnInstanceId?: string,
): PendingTool | undefined {
  if (!isRecord(rawTool)) return undefined;
  const toolCallId = optionalString(rawTool.toolCallId);
  if (!toolCallId) return undefined;
  return {
    toolCallId,
    name: optionalString(rawTool.name) ?? "unknown",
    turnId: optionalString(rawTool.turnId) ?? fallbackTurnId,
    turnInstanceId: optionalString(rawTool.turnInstanceId) ?? fallbackTurnInstanceId,
    sourceEventId: optionalString(rawTool.sourceEventId),
    args: rawTool.args as ToolArgs | undefined,
    startedAt: optionalString(rawTool.startedAt),
    progressText: optionalString(rawTool.progressText),
    parentToolCallId: optionalString(rawTool.parentToolCallId),
    isSubAgent: optionalBoolean(rawTool.isSubAgent),
    completedAt: optionalString(rawTool.completedAt),
    success: optionalBoolean(rawTool.success),
    result: optionalString(rawTool.result),
  };
}

export function normalizeLiveVisual(value: unknown): LiveVisual | undefined {
  if (!isRecord(value) || typeof value.artifactId !== "string") return undefined;
  return value as unknown as LiveVisual;
}

export function normalizeLiveVisuals(value: unknown): LiveVisual[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((visual) => {
    const normalized = normalizeLiveVisual(visual);
    return normalized ? [normalized] : [];
  });
}

export function normalizeLiveCompletion(value: unknown): LiveCompletion | null {
  if (!isRecord(value) || !isRecord(value.completion)) return null;
  const completion = value.completion as unknown as TerminalCompletion;
  if (typeof completion.content !== "string" || !completion.content) return null;
  return {
    completion,
    ...(optionalString(value.sourceEventId) ? { sourceEventId: optionalString(value.sourceEventId) } : {}),
    ...(optionalString(value.timestamp) ? { timestamp: optionalString(value.timestamp) } : {}),
    ...(optionalString(value.turnId) ? { turnId: optionalString(value.turnId) } : {}),
    ...(optionalString(value.turnInstanceId)
      ? { turnInstanceId: optionalString(value.turnInstanceId) }
      : {}),
  };
}

export function normalizeLiveTools(
  rawTools: unknown,
  sessionId: string,
  fallbackTurnId?: string,
  fallbackTurnInstanceId?: string,
): PendingTool[] {
  if (!Array.isArray(rawTools)) return [];
  const tools = new Map<string, PendingTool>();
  for (const rawTool of rawTools) {
    const tool = normalizeActiveTool(rawTool, fallbackTurnId, fallbackTurnInstanceId);
    if (!tool || isHiddenTool(tool.name, tool.args, sessionId)) continue;
    tools.set(tool.toolCallId, tool);
  }
  return [...tools.values()];
}

/** Merge a live tool patch into the active set, creating the entry when the patch arrives first. */
export function upsertLiveTool(tools: PendingTool[], patch: PendingTool): PendingTool[] {
  const index = tools.findIndex((tool) => tool.toolCallId === patch.toolCallId);
  if (index < 0) return [...tools, patch];
  return tools.map((tool, currentIndex) => currentIndex === index
    ? {
        ...tool,
        ...patch,
        toolCallId: tool.toolCallId,
        name: getKnownToolName(patch.name) ?? getKnownToolName(tool.name) ?? patch.name,
        turnId: patch.turnId ?? tool.turnId,
        turnInstanceId: patch.turnInstanceId ?? tool.turnInstanceId,
        sourceEventId: tool.sourceEventId ?? patch.sourceEventId,
        args: patch.args ?? tool.args,
        parentToolCallId: patch.parentToolCallId ?? tool.parentToolCallId,
        isSubAgent: patch.isSubAgent ?? tool.isSubAgent,
        startedAt: patch.startedAt ?? tool.startedAt,
        progressText: patch.progressText ?? tool.progressText,
        completedAt: patch.completedAt ?? tool.completedAt,
        success: patch.success ?? tool.success,
        result: patch.result ?? tool.result,
      }
    : tool);
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

/**
 * Drop disk-backed segments at a turn boundary. A new turn proves the previous turn's assistant
 * messages reached `events.jsonl`, while bridge-native segments never will and must survive.
 */
export function dropDiskBackedSegments(segments: LiveAssistantSegment[]): LiveAssistantSegment[] {
  return segments.filter((segment) => segment.bridgeNative === true);
}

function appendAssistantSegment(
  segments: LiveAssistantSegment[],
  next: LiveAssistantSegment,
): LiveAssistantSegment[] {
  const index = segments.findIndex((segment) => segment.id === next.id);
  if (index < 0) return [...segments, next];
  return segments.map((segment, segmentIndex) => segmentIndex === index ? next : segment);
}

export function useSessionStream(
  sessionId: string | null,
  onSettled: () => void,
  onTitleChanged: () => void,
  onMcpStatus?: (servers: McpServerStatus[]) => void,
) {
  const [streamState, setStreamState] = useState<StreamState>(() => createState("idle"));
  const streamStateRef = useRef(streamState);
  streamStateRef.current = streamState;
  const sessionRef = useRef<string | null>(sessionId);
  const eventSourceRef = useRef<EventSource | null>(null);
  const generationRef = useRef(0);
  const lastRunIdRef = useRef<string | undefined>(undefined);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const onTitleChangedRef = useRef(onTitleChanged);
  onTitleChangedRef.current = onTitleChanged;
  const onMcpStatusRef = useRef(onMcpStatus);
  onMcpStatusRef.current = onMcpStatus;

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
    setStreamState((current) => createState("sending", {
      contextSummary: current.contextSummary,
      historyEpoch: current.historyEpoch,
      elicitationCancellation: pendingOrigin === "reconnect" ? current.elicitationCancellation : null,
      runNotice: pendingOrigin === "reconnect" ? current.runNotice : null,
      pendingUserInputs: pendingOrigin === "reconnect" ? current.pendingUserInputs : [],
      pendingElicitations: pendingOrigin === "reconnect" ? current.pendingElicitations : [],
      liveAssistantSegments: pendingOrigin === "reconnect" ? current.liveAssistantSegments : [],
      pendingUserMessages: pendingOrigin === "reconnect" ? current.pendingUserMessages : [],
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
          contextSummary: current.contextSummary,
          elicitationCancellation: current.elicitationCancellation,
          runNotice: current.runNotice,
          liveAssistantSegments: current.liveAssistantSegments,
          pendingUserMessages: current.pendingUserMessages,
          historyEpoch: current.historyEpoch,
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
        const snapshotRunId = optionalString(event.runId);
        const turnId = getEventTurnId(event);
        const turnInstanceId = getEventTurnInstanceId(event);
        const liveTools = normalizeLiveTools(event.liveTools, sid, turnId, turnInstanceId);
        const liveVisuals = normalizeLiveVisuals(event.liveVisuals);
        const liveCompletion = normalizeLiveCompletion(event.liveCompletion);
        const liveAssistantSegments = normalizeLiveAssistantSegments(event.liveAssistantSegments);
        const pendingUserMessages = normalizePendingUserMessages(event.pendingUserMessages);
        const streamingContent = optionalString(event.streamingContent) ?? "";
        const contextSummary = getStreamContextSummary(event);
        if (Array.isArray(event.mcpServers)) {
          onMcpStatusRef.current?.(normalizeMcpServerStatuses(event.mcpServers));
        }
        const complete = event.complete === true;
        const previousRunId = lastRunIdRef.current;
        lastRunIdRef.current = snapshotRunId;
        const hasLiveOutput = liveAssistantSegments.length > 0
          || liveTools.length > 0
          || liveVisuals.length > 0
          || Boolean(streamingContent);
        if (complete) closeCurrent();
        setStreamState((current) => createState(
          complete ? "idle" : (hasLiveOutput ? "streaming" : "thinking"),
          {
            liveAssistantSegments,
            pendingUserMessages,
            streamingContent: complete ? "" : streamingContent,
            // Completed items stay after a terminal snapshot until the disk read confirms them.
            liveTools,
            liveVisuals,
            liveCompletion,
            pendingUserInputs: complete ? [] : normalizePendingUserInputRequests(event.pendingUserInputs),
            pendingElicitations: complete
              ? []
              : normalizePendingElicitationRequests(event.pendingElicitations),
            intentText: complete ? "" : optionalString(event.intentText) ?? "",
            contextSummary: contextSummary ?? current.contextSummary,
            elicitationCancellation: current.elicitationCancellation,
            runNotice: normalizeRunNotice(event.runNotice) ?? (complete ? null : current.runNotice),
            hadVisibleOutput: hasLiveOutput,
            pendingOrigin: complete ? null : current.pendingOrigin,
            runMode: current.runMode,
            // A snapshot from a different run means committed history moved while disconnected.
            historyEpoch: snapshotRunId === previousRunId
              ? current.historyEpoch
              : current.historyEpoch + 1,
            activeTurnId: turnId,
            activeTurnInstanceId: turnInstanceId,
          },
        ));
        if (complete) {
          report("stream.terminal", { terminalType: event.terminalType, source: "snapshot" });
          onSettledRef.current();
          if (event.terminalType === "done") onTitleChangedRef.current();
        }
        return;
      }

      if (eventType === "history_advanced") {
        setStreamState((current) => ({ ...current, historyEpoch: current.historyEpoch + 1 }));
        return;
      }

      if (eventType === "resync_required") {
        closeCurrent();
        setStreamState((current) => createState("idle", {
          contextSummary: current.contextSummary,
          elicitationCancellation: current.elicitationCancellation,
          runNotice: current.runNotice,
          historyEpoch: current.historyEpoch + 1,
        }));
        report("stream.resync_required");
        onSettledRef.current();
        return;
      }

      if (eventType === "thinking") {
        setStreamState((current) => ({
          ...current,
          // A new turn proves the previous turn's assistant text reached disk.
          liveAssistantSegments: dropDiskBackedSegments(current.liveAssistantSegments),
          streamStatus: "thinking",
          isStreaming: true,
          runNotice: null,
          // A new turn proves the previous turn's items reached disk.
          liveTools: [],
          liveVisuals: [],
          liveCompletion: null,
          activeTurnId: getEventTurnId(event) ?? current.activeTurnId,
          activeTurnInstanceId: getEventTurnInstanceId(event) ?? current.activeTurnInstanceId,
        }));
        return;
      }
      if (eventType === "user_message" || eventType === "user_message_updated") {
        const message = normalizePendingUserMessage(event.userMessage);
        if (message) {
          setStreamState((current) => {
            const index = current.pendingUserMessages.findIndex((entry) => entry.id === message.id);
            return {
              ...current,
              pendingUserMessages: index < 0
                ? [...current.pendingUserMessages, message]
                : current.pendingUserMessages.map((entry, entryIndex) => (
                    entryIndex === index ? { ...entry, ...message } : entry
                  )),
              hadVisibleOutput: true,
            };
          });
        }
        return;
      }
      if (eventType === "user_message_committed") {
        const id = optionalString(event.id);
        if (!id) return;
        setStreamState((current) => ({
          ...current,
          pendingUserMessages: current.pendingUserMessages.map((entry) => entry.id === id
            ? {
                ...entry,
                ...(optionalString(event.sourceEventId)
                  ? { sourceEventId: optionalString(event.sourceEventId) }
                  : {}),
                ...(optionalString(event.timestamp) ? { timestamp: optionalString(event.timestamp) } : {}),
              }
            : entry),
        }));
        return;
      }
      if (eventType === "user_message_discarded") {
        const id = optionalString(event.id);
        if (id) {
          setStreamState((current) => ({
            ...current,
            pendingUserMessages: current.pendingUserMessages.filter((entry) => entry.id !== id),
          }));
        }
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
          activeTurnInstanceId: getEventTurnInstanceId(event) ?? current.activeTurnInstanceId,
        }));
        return;
      }
      if (eventType === "assistant_partial") {
        setStreamState((current) => {
          const eventContent = typeof event.content === "string" ? event.content : "";
          // Mirror the server rule: an empty assistant message yields no disk entry, so its event
          // id must never be stamped onto streamed text that would then be unable to retire.
          if (!eventContent && current.streamingContent) return current;
          const content = eventContent || current.streamingContent;
          if (!content) return { ...current, streamingContent: "" };
          const sourceEventId = optionalString(event.sourceEventId);
          return {
            ...current,
            liveAssistantSegments: appendAssistantSegment(current.liveAssistantSegments, {
              id: sourceEventId ?? `segment-${current.liveAssistantSegments.length}-${content.length}`,
              content,
              ...(sourceEventId ? { sourceEventId } : {}),
              ...(event.bridgeNative === true ? { bridgeNative: true } : {}),
              ...(getEventTurnId(event) ? { turnId: getEventTurnId(event) } : {}),
              ...(getEventTurnInstanceId(event)
                ? { turnInstanceId: getEventTurnInstanceId(event) }
                : {}),
              ...(optionalString(event.timestamp) ? { timestamp: optionalString(event.timestamp) } : {}),
            }),
            streamingContent: "",
            hadVisibleOutput: true,
            activeTurnId: getEventTurnId(event) ?? current.activeTurnId,
            activeTurnInstanceId: getEventTurnInstanceId(event) ?? current.activeTurnInstanceId,
          };
        });
        return;
      }
      if (
        eventType === "tool_start"
        || eventType === "tool_progress"
        || eventType === "tool_output"
        || eventType === "tool_update"
      ) {
        const toolCallId = optionalString(event.toolCallId);
        if (!toolCallId) return;
        setStreamState((current) => {
          const progressText = optionalString(
            eventType === "tool_output" ? event.content : event.message,
          );
          const patch: PendingTool = {
            toolCallId,
            name: getKnownToolName(event.name) ?? "unknown",
            turnId: getEventTurnId(event),
            turnInstanceId: getEventTurnInstanceId(event),
            sourceEventId: optionalString(event.sourceEventId),
            args: event.args as ToolArgs | undefined,
            parentToolCallId: optionalString(event.parentToolCallId),
            isSubAgent: optionalBoolean(event.isSubAgent),
            ...(eventType === "tool_start" ? { startedAt: optionalString(event.timestamp) } : {}),
            ...(progressText ? { progressText } : {}),
          };
          const existing = current.liveTools.find((tool) => tool.toolCallId === toolCallId);
          const resolvedName = getKnownToolName(patch.name) ?? existing?.name ?? "unknown";
          if (isHiddenTool(resolvedName, patch.args ?? existing?.args, sid)) return current;
          // Progress for a tool that already completed must not resurrect it.
          if (!existing && eventType !== "tool_start" && eventType !== "tool_update") return current;
          return {
            ...current,
            liveTools: upsertLiveTool(current.liveTools, patch),
            streamStatus: "streaming",
            isStreaming: true,
            hadVisibleOutput: true,
          };
        });
        return;
      }
      if (eventType === "tool_done") {
        const toolCallId = optionalString(event.toolCallId);
        if (!toolCallId) return;
        setStreamState((current) => {
          const existing = current.liveTools.find((tool) => tool.toolCallId === toolCallId);
          const name = getKnownToolName(event.name) ?? existing?.name ?? "unknown";
          if (isHiddenTool(name, existing?.args, sid)) {
            return {
              ...current,
              liveTools: current.liveTools.filter((tool) => tool.toolCallId !== toolCallId),
            };
          }
          // Retain the finished tool with its result so it renders immediately; the view drops it
          // once disk history carries the same completed state.
          return {
            ...current,
            liveTools: upsertLiveTool(current.liveTools, {
              toolCallId,
              name,
              turnId: getEventTurnId(event),
              turnInstanceId: getEventTurnInstanceId(event),
              sourceEventId: optionalString(event.sourceEventId),
              parentToolCallId: optionalString(event.parentToolCallId),
              isSubAgent: optionalBoolean(event.isSubAgent),
              completedAt: optionalString(event.timestamp) ?? new Date().toISOString(),
              success: optionalBoolean(event.success),
              result: optionalString(event.result),
            }),
            hadVisibleOutput: true,
          };
        });
        return;
      }
      if (eventType === "visual_published") {
        const visual = normalizeLiveVisual(event);
        if (visual) {
          setStreamState((current) => ({
            ...current,
            liveVisuals: [
              ...current.liveVisuals.filter((candidate) => candidate.artifactId !== visual.artifactId),
              visual,
            ],
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
          streamStatus: current.streamingContent || current.liveTools.length > 0 ? "streaming" : "thinking",
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
          streamStatus: current.streamingContent || current.liveTools.length > 0 ? "streaming" : "thinking",
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
          if (!request) return current;
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
        onMcpStatusRef.current?.(normalizeMcpServerStatuses(event.servers));
        return;
      }
      if (eventType === "context_update") {
        const summary = getStreamContextSummary(event);
        if (summary) setStreamState((current) => ({ ...current, contextSummary: summary }));
        return;
      }
      if (eventType === "history_truncated") {
        setStreamState((current) => ({
          ...current,
          liveAssistantSegments: [],
          historyEpoch: current.historyEpoch + 1,
        }));
        onSettledRef.current();
        return;
      }
      if (eventType === "done" || eventType === "error" || eventType === "aborted" || eventType === "shutdown") {
        closeCurrent();
        setStreamState((current) => {
          const canceledElicitation = eventType === "done"
            ? undefined
            : current.pendingElicitations[0];
          return createState("idle", {
            liveAssistantSegments: current.liveAssistantSegments,
            pendingUserMessages: current.pendingUserMessages,
            // Results and completion cards remain the freshest copy until the final disk read.
            liveTools: current.liveTools.map((tool) => tool.completedAt
              ? tool
              : { ...tool, completedAt: optionalString(event.timestamp) ?? new Date().toISOString(), success: eventType === "done" }),
            liveVisuals: current.liveVisuals,
            liveCompletion: normalizeLiveCompletion(event.liveCompletion) ?? current.liveCompletion,
            contextSummary: current.contextSummary,
            runNotice: normalizeRunNotice(event.runNotice),
            historyEpoch: current.historyEpoch + 1,
            elicitationCancellation: current.elicitationCancellation
              ?? (canceledElicitation
                ? {
                    requestId: canceledElicitation.requestId,
                    question: canceledElicitation.message,
                    detail: eventType === "error"
                      ? optionalString(event.message) ?? "The request was canceled because the session failed."
                      : "The request was canceled because the session ended.",
                    ...(optionalString(event.timestamp) ? { timestamp: optionalString(event.timestamp) } : {}),
                  }
                : null),
            hadVisibleOutput: current.hadVisibleOutput,
            activeTurnId: getEventTurnId(event) ?? current.activeTurnId,
            activeTurnInstanceId: getEventTurnInstanceId(event) ?? current.activeTurnInstanceId,
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
    lastRunIdRef.current = undefined;
    setStreamState(createState("idle"));
    return closeStream;
  }, [closeStream, sessionId]);

  const sendMessage = useCallback(async (prompt: string, attachments?: Attachment[], mode?: SendMode) => {
    if (!sessionId) return;
    const startedFromIdle = streamStateRef.current.streamStatus === "idle";
    if (startedFromIdle) {
      setStreamState((current) => createState("sending", {
        contextSummary: current.contextSummary,
        historyEpoch: current.historyEpoch,
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
          contextSummary: current.contextSummary,
          historyEpoch: current.historyEpoch,
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
