import { getToolExecutionDisplayText } from "./tool-results.js";

// Shared event→entry transform logic
// Produces a flat chronological list of text messages, tool calls, and visual artifacts.
// Used by both getSessionMessages (SDK path) and readMessagesFromDisk (fast path)

export interface TransformedVisual {
  artifactId: string;
  kind: "image" | "mermaid" | "vega-lite" | "html";
  title: string;
  displayName: string;
  mimeType: string;
  size: number;
  url: string;
  downloadUrl: string;
  caption?: string;
  altText?: string;
  /** Kept for wire compatibility; history replay leaves source unset and clients fetch from url. */
  source?: string;
}

export interface TransformedEntry {
  id: string;
  type: "message" | "tool" | "visual";
  turnId?: string;
  // Message fields (when type === "message")
  role?: string;
  content?: string;
  timestamp?: string;
  forkBoundaryEventId?: string;
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
  // Visual fields (when type === "visual")
  visual?: TransformedVisual;
}

// Keep backward compat alias — server API consumers still reference this
export type TransformedMessage = TransformedEntry;

function isTurnTerminalEvent(event: any): boolean {
  return event.type === "assistant.turn_end"
    || event.type === "session.shutdown"
    || event.type === "abort"
    || event.type === "session.idle"
    || event.type === "session.error";
}

const FORK_BOUNDARY_SKIP_EVENT_TYPES = new Set(["system.message"]);

function getRawEventId(event: any): string | undefined {
  const id = event?.id ?? event?.eventId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function getNextForkBoundaryEventId(events: any[], startIndex: number): string | undefined {
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (FORK_BOUNDARY_SKIP_EVENT_TYPES.has(event?.type)) continue;
    const id = getRawEventId(event);
    if (id) return id;
  }
  return undefined;
}

function getAssistantForkBoundaries(events: any[]): Map<string, string> {
  const boundaries = new Map<string, string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "assistant.message" || event?.data?.parentToolCallId) continue;
    const assistantEventId = getRawEventId(event);
    if (!assistantEventId) continue;

    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const nextEvent = events[nextIndex];
      if (nextEvent?.type === "assistant.turn_end") {
        const boundaryEventId = getNextForkBoundaryEventId(events, nextIndex + 1);
        if (boundaryEventId) boundaries.set(assistantEventId, boundaryEventId);
        break;
      }
      if (
        nextEvent?.type === "assistant.turn_start"
        || nextEvent?.type === "user.message"
        || (nextEvent?.type === "assistant.message" && !nextEvent?.data?.parentToolCallId)
        || isTurnTerminalEvent(nextEvent)
      ) {
        break;
      }
    }
  }
  return boundaries;
}

function getUserMessageContent(event: any): string {
  if (event?.type !== "user.message") return "";
  const content = event?.data?.content ?? event?.data?.prompt;
  return typeof content === "string" ? content : "";
}

export function parseDeferMetadata(content: string): Record<string, string> | undefined {
  const start = content.indexOf("<defer>");
  const end = content.indexOf("</defer>", start + "<defer>".length);
  if (start < 0 || end < 0) return undefined;

  const metadata: Record<string, string> = {};
  const block = content.slice(start + "<defer>".length, end);
  for (const rawLine of block.split(/\r?\n/)) {
    const separator = rawLine.indexOf(":");
    if (separator <= 0) continue;
    const key = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (key && value) metadata[key] = value;
  }
  return metadata;
}

export function isQuietIntervalDeferEvent(event: any, expectedDeferId?: string): boolean {
  const metadata = parseDeferMetadata(getUserMessageContent(event));
  return metadata?.kind === "interval"
    && metadata.attentionMode === "quiet"
    && (expectedDeferId === undefined || metadata.deferId === expectedDeferId);
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

export function isVisibleTransformedEntryEvent(event: any, sessionId?: string): boolean {
  return isVisibleMessageEvent(event, sessionId);
}

function parsePublishedVisualResult(rawResult: unknown): Record<string, unknown> | undefined {
  if (rawResult && typeof rawResult === "object") {
    const result = rawResult as Record<string, unknown>;
    if (result.__kind === "visual.published") return result;
    for (const key of ["detailedContent", "content", "textResultForLlm"]) {
      const parsed = parsePublishedVisualResult(result[key]);
      if (parsed) return parsed;
    }
    return undefined;
  }
  if (typeof rawResult !== "string") return undefined;
  const trimmed = rawResult.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("\"visual.published\"")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const VISUAL_ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isExpectedVisualArtifactUrl(value: unknown, sessionId: string | undefined, artifactId: string, suffix = ""): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
  if (!VISUAL_ARTIFACT_ID_RE.test(artifactId)) return false;
  if (!sessionId) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, "http://bridge.local");
  } catch {
    return false;
  }
  if (parsed.origin !== "http://bridge.local") return false;
  if (parsed.search || parsed.hash) return false;
  const expectedPath = `/api/sessions/${encodeURIComponent(sessionId)}/visuals/${encodeURIComponent(artifactId)}${suffix}`;
  return parsed.pathname.endsWith(expectedPath);
}

export function getVisualArtifactFromToolCompletion(
  event: any,
  toolName: string | undefined,
  sessionId?: string,
): TransformedVisual | undefined {
  const data = event?.data;
  if (toolName !== "publish_visual" || !sessionId || data?.success === false) return undefined;
  const rawResult = parsePublishedVisualResult(data?.result);
  if (!rawResult || rawResult.__kind !== "visual.published") return undefined;

  const artifactId = rawResult.artifactId;
  if (
    typeof artifactId !== "string"
    || !isExpectedVisualArtifactUrl(rawResult.url, sessionId, artifactId)
    || (
      rawResult.downloadUrl !== undefined
      && !isExpectedVisualArtifactUrl(rawResult.downloadUrl, sessionId, artifactId, "/download")
    )
  ) {
    return undefined;
  }

  const kind: "image" | "mermaid" | "vega-lite" | "html" =
    rawResult.kind === "mermaid"
      ? "mermaid"
      : rawResult.kind === "vega-lite"
        ? "vega-lite"
        : rawResult.kind === "html"
          ? "html"
          : "image";
  return {
    artifactId,
    kind,
    title: typeof rawResult.title === "string"
      ? rawResult.title
      : typeof rawResult.displayName === "string"
        ? rawResult.displayName
        : artifactId,
    displayName: typeof rawResult.displayName === "string" ? rawResult.displayName : artifactId,
    mimeType: typeof rawResult.mimeType === "string"
      ? rawResult.mimeType
      : kind === "mermaid"
        ? "text/vnd.mermaid"
        : kind === "vega-lite"
          ? "application/vnd.vegalite+json"
          : kind === "html"
            ? "text/html"
            : "image/png",
    size: typeof rawResult.size === "number" ? rawResult.size : 0,
    url: rawResult.url,
    downloadUrl: typeof rawResult.downloadUrl === "string" ? rawResult.downloadUrl : rawResult.url,
    ...(typeof rawResult.caption === "string" ? { caption: rawResult.caption } : {}),
    ...(typeof rawResult.altText === "string" ? { altText: rawResult.altText } : {}),
  };
}

export function getVisibleEventTimestamp(event: any, sessionId?: string): string | undefined {
  if (!isVisibleMessageEvent(event, sessionId)) return undefined;
  return event?.data?.timestamp ?? event?.timestamp;
}

export function createVisibleActivityTracker(sessionId?: string) {
  const openVisibleToolCallIds = new Set<string>();
  let lastVisibleActivityAt: string | undefined;
  let quietTurn = false;

  function observe(event: any): string | undefined {
    if (event.type === "user.message") {
      quietTurn = isQuietIntervalDeferEvent(event);
      if (quietTurn) {
        openVisibleToolCallIds.clear();
        return lastVisibleActivityAt;
      }
    } else if (quietTurn) {
      if (isTurnTerminalEvent(event)) {
        quietTurn = false;
        openVisibleToolCallIds.clear();
      }
      return lastVisibleActivityAt;
    }

    const timestamp = getVisibleEventTimestamp(event, sessionId);
    if (timestamp) {
      lastVisibleActivityAt = timestamp;
      if (event.type === "tool.execution_start" && event?.data?.toolCallId) {
        openVisibleToolCallIds.add(event.data.toolCallId);
      }
      return lastVisibleActivityAt;
    }

    if (event.type === "tool.execution_complete" && event?.data?.toolCallId && openVisibleToolCallIds.has(event.data.toolCallId)) {
      const completedAt = event?.timestamp;
      if (completedAt) lastVisibleActivityAt = completedAt;
      openVisibleToolCallIds.delete(event.data.toolCallId);
      return lastVisibleActivityAt;
    }

    if (isTurnTerminalEvent(event) && openVisibleToolCallIds.size > 0) {
      const terminalAt = event?.timestamp;
      if (terminalAt) lastVisibleActivityAt = terminalAt;
      openVisibleToolCallIds.clear();
    }
    return lastVisibleActivityAt;
  }

  return {
    observe,
    getLastVisibleActivityAt: () => lastVisibleActivityAt,
  };
}

export function getLastVisibleActivityAt(events: any[], sessionId?: string): string | undefined {
  const tracker = createVisibleActivityTracker(sessionId);
  for (const event of events) {
    tracker.observe(event);
  }
  return tracker.getLastVisibleActivityAt();
}

export interface TransformEventsToMessagesOptions {
  initialTurnIndex?: number;
  initialActiveTurnId?: string;
}

/**
 * Transform raw SDK/JSONL events into a chronological list of entries.
 * Pass 1 indexes tool completion results, pass 2 emits entries in event order.
 */
export function transformEventsToMessages(
  events: any[],
  sessionId?: string,
  options: TransformEventsToMessagesOptions = {},
): TransformedEntry[] {
  const entries: TransformedEntry[] = [];
  let idx = 0;
  let turnIndex = options.initialTurnIndex ?? 0;
  let activeTurnId = options.initialActiveTurnId;

  // Pass 1: Index tool completions and sub-agent metadata for enrichment
  const toolCompletes = new Map<string, { success: boolean; result?: string; timestamp?: string }>();
  const toolProgress = new Map<string, string>();
  const openToolCallIds = new Set<string>();
  const subAgentStarts = new Map<string, { agentName: string; agentDisplayName: string }>();
  const subAgentResponses = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const assistantForkBoundaries = getAssistantForkBoundaries(events);
  // Detect visual artifact publications from publish_visual tool completions
  const visualResults = new Map<string, TransformedVisual>();

  for (const event of events) {
    const data = (event as any).data;
    if (event.type === "tool.execution_start" && data?.toolCallId) {
      openToolCallIds.add(data.toolCallId);
      toolNames.set(data.toolCallId, data.toolName ?? data.name ?? "unknown");
    } else if (event.type === "tool.execution_complete" && data?.toolCallId) {
      toolCompletes.set(data.toolCallId, {
        success: data.success,
        result: getToolExecutionDisplayText(data),
        timestamp: (event as any).timestamp,
      });
      openToolCallIds.delete(data.toolCallId);
      const visual = getVisualArtifactFromToolCompletion(event, toolNames.get(data.toolCallId), sessionId);
      if (visual) visualResults.set(data.toolCallId, visual);
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

    if (event.type === "assistant.turn_start") {
      activeTurnId = `turn-${++turnIndex}`;
    } else if (isTurnTerminalEvent(event)) {
      activeTurnId = undefined;
    } else if (event.type === "user.message") {
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
        const rawEventId = getRawEventId(event);
        const forkBoundaryEventId = rawEventId ? assistantForkBoundaries.get(rawEventId) : undefined;
        entries.push({
          id: `entry-${idx++}`,
          type: "message",
          role: "assistant",
          content,
          timestamp: data.timestamp ?? (event as any).timestamp,
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
          ...(forkBoundaryEventId ? { forkBoundaryEventId } : {}),
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
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
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
      // Emit a visual entry immediately after the tool entry for publish_visual completions
      const visual = visualResults.get(data.toolCallId);
      if (visual) {
        entries.push({
          id: `entry-${idx++}`,
          type: "visual",
          visual,
          timestamp: complete?.timestamp ?? (event as any).timestamp,
        });
      }
    }
  }

  return entries;
}
