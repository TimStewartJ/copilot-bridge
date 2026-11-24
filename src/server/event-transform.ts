import { win32 as winPath } from "node:path";
import { isCustomContinuationMessage } from "./custom-autopilot.js";
import {
  buildSubagentInstructions,
  SubagentCorrelator,
  resolveToolOutcome,
  type ToolCompletionRecord,
} from "./subagent-correlation.js";
import {
  extractTerminalCompletion,
  extractTerminalCompletionFromToolCall,
  isTerminalTurnEventType,
  type TerminalCompletion,
} from "../shared/terminal-completion.js";
import { isHiddenTool } from "../shared/tool-visibility.js";
import {
  getAssistantTurnInstanceId,
  getSdkAgentId,
  getSdkEventId,
  getSdkTurnId,
  isNonTerminalSessionError,
  isSdkAgentUserMessage,
  isSdkPersistenceSessionError,
  isSdkUserAuthoredMessage,
} from "./sdk-event-identity.js";
import { AgentEventOwners, showsAgentTurnsAreStamped } from "./agent-event-ownership.js";
import { transcriptTurnDetails } from "./transcript-turn-details.js";
import type { ChatTurnDetails } from "../shared/chat-turn-details.js";
import { isToolAccompanyingProgress } from "../shared/progress-update.js";
import { isRecord } from "../shared/is-record.js";

// Turns session events into a flat chronological list of messages, tools and visuals.

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
  type: "message" | "tool" | "visual" | "completion" | "skill" | "reasoning" | "continuation";
  turnId?: string;
  turnInstanceId?: string;
  sourceEventId?: string;
  // Message fields (when type === "message")
  role?: string;
  content?: string;
  model?: string;
  /** Assistant text emitted alongside non-interactive tool calls during a turn. */
  progressUpdate?: boolean;
  turnDetails?: ChatTurnDetails;
  timestamp?: string;
  forkBoundaryEventId?: string;
  undoEventId?: string;
  /** User messages: the runtime's id for the message, as returned by `session.send`. */
  messageId?: string;
  /** User messages: the browser's id for the message it sent, when Bridge recorded one. */
  clientMessageId?: string;
  attachments?: Array<
    | { type: "blob"; data?: string; mimeType: string; displayName?: string }
    | { type: "file"; path: string; displayName: string }
  >;
  /** Set on a user message sent in autopilot; absent for interactive sends. */
  agentMode?: "autopilot";
  // Skill fields (when type === "skill") — agent-injected skill context, shown as a collapsed card
  skill?: { id: string; label: string };
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
    agentInstructions?: import("../shared/subagent.js").AgentInstruction[];
    startedAt?: string;
    completedAt?: string;
  };
  // Visual fields (when type === "visual")
  visual?: TransformedVisual;
  // Completion fields (when type === "completion")
  completion?: TerminalCompletion;
  /** No sourceEventId: its assistant.message id already keys that reply's own entry. */
  reasoning?: { messageEventId?: string; startedAt?: string };
}

// Logs span runtime versions and are read as plain JSON, so event fields are narrowed where read.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function eventType(event: unknown): unknown {
  return asRecord(event)?.type;
}

function eventData(event: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(event)?.data);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/** The event's own time, from its envelope. */
function eventTimestamp(event: unknown): string | undefined {
  return stringField(asRecord(event), "timestamp");
}

/** The time a message carries in its payload, else the event's own time. */
function messageTimestamp(event: unknown): string | undefined {
  const timestamp = eventData(event)?.timestamp ?? asRecord(event)?.timestamp;
  return typeof timestamp === "string" ? timestamp : undefined;
}

function messageText(data: Record<string, unknown> | undefined): string {
  const text = data?.content ?? data?.prompt ?? "";
  return typeof text === "string" ? text : "";
}

function toolNameOf(data: Record<string, unknown> | undefined): string {
  const name = data?.toolName ?? data?.name ?? "unknown";
  return typeof name === "string" ? name : "unknown";
}

function hasAttachments(data: Record<string, unknown> | undefined): boolean {
  const attachments = data?.attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

function isTurnTerminalEvent(event: unknown): boolean {
  return isTerminalTurnEventType(eventType(event))
    && !isNonTerminalSessionError(event);
}

/** A completion card as the transcript records it: its keyed event and that event's time. */
export interface TranscriptCompletion {
  completion: TerminalCompletion;
  sourceEventId?: string;
  timestamp?: string;
}

/** Shared by disk and live, so a live card has the id of the disk entry that replaces it. */
export function getTranscriptCompletion(
  event: unknown,
  pending: TerminalCompletion | undefined,
): TranscriptCompletion | undefined {
  const own = extractTerminalCompletion(event);
  const completion = own ?? (pending && isTurnTerminalEvent(event) ? pending : undefined);
  if (!completion) return undefined;
  const sourceEventId = getSdkEventId(event);
  const timestamp = own ? eventTimestamp(event) : messageTimestamp(event);
  return {
    completion,
    ...(sourceEventId ? { sourceEventId } : {}),
    ...(typeof timestamp === "string" ? { timestamp } : {}),
  };
}

const FORK_BOUNDARY_SKIP_EVENT_TYPES = new Set(["system.message"]);

/** Event types whose `data` the transcript reads; others matter only by `type` and `id`. */
export const TRANSCRIPT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.message",
  "assistant.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "session.usage_record",
  "session.fusion_resolved",
  "session.fusion_completed",
  "assistant.fusion_phase_completed",
  "tool.execution_start",
  "tool.execution_complete",
  "tool.execution_progress",
  "tool.execution_partial_result",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "session.error",
  "session.idle",
  "session.shutdown",
  "session.task_complete",
  "abort",
]);

/** Drops unread payloads so a whole-history read does not hold every binary asset in memory. */
export function projectTranscriptEvent(event: unknown): unknown {
  if (!event || typeof event !== "object" || Array.isArray(event) || !("data" in event)) return event;
  const record = event as Record<string, unknown>;
  if (typeof record.type === "string" && TRANSCRIPT_EVENT_TYPES.has(record.type)) return event;
  const { data: _data, ...envelope } = record;
  return envelope;
}

function getRawEventId(event: unknown): string | undefined {
  return getSdkEventId(event);
}

function getNextForkBoundaryEventId(events: readonly unknown[], startIndex: number): string | undefined {
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    const type = eventType(event);
    if (typeof type === "string" && FORK_BOUNDARY_SKIP_EVENT_TYPES.has(type)) continue;
    const id = getRawEventId(event);
    if (id) return id;
  }
  return undefined;
}

function getAssistantForkBoundaries(events: readonly unknown[]): Map<string, string> {
  const boundaries = new Map<string, string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (eventType(event) !== "assistant.message" || eventData(event)?.parentToolCallId) continue;
    const assistantEventId = getRawEventId(event);
    if (!assistantEventId) continue;

    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const nextEvent = events[nextIndex];
      const nextType = eventType(nextEvent);
      if (nextType === "assistant.turn_end") {
        const boundaryEventId = getNextForkBoundaryEventId(events, nextIndex + 1);
        if (boundaryEventId) boundaries.set(assistantEventId, boundaryEventId);
        break;
      }
      if (
        nextType === "assistant.turn_start"
        || (nextType === "user.message" && !isSdkAgentUserMessage(nextEvent))
        || (nextType === "assistant.message" && !eventData(nextEvent)?.parentToolCallId)
        || isTurnTerminalEvent(nextEvent)
      ) {
        break;
      }
    }
  }
  return boundaries;
}

function getUserMessageContent(event: unknown): string {
  if (eventType(event) !== "user.message") return "";
  return messageText(eventData(event));
}

// SDK tags injected skill context as source 'skill-<id>'; keep it out of the timeline.
const SKILL_SOURCE_PATTERN = /^skill(?:[-:]|$)/i;

function getSkillSource(event: unknown): string | undefined {
  if (eventType(event) !== "user.message") return undefined;
  const source = eventData(event)?.source;
  if (typeof source !== "string") return undefined;
  const trimmed = source.trim();
  return SKILL_SOURCE_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Runtime-injected source 'system' messages (system_reminder) are not user speech; hide them. */
function isAgentInjectedSystemMessage(event: unknown): boolean {
  if (eventType(event) !== "user.message") return false;
  const source = eventData(event)?.source;
  return typeof source === "string" && source.trim().toLowerCase() === "system";
}

/** Native continuation markers and the Bridge's own automatic follow-ups aren't user speech. */
export function isAutopilotContinuationEvent(event: unknown): boolean {
  if (isCustomContinuationMessage(event)) return true;
  if (eventType(event) !== "user.message" || isSdkAgentUserMessage(event) || isAgentInjectedSystemMessage(event)) {
    return false;
  }
  const data = eventData(event);
  if (data?.isAutopilotContinuation === true) return true;
  const content = data?.content ?? data?.prompt ?? "";
  return data?.agentMode === "autopilot"
    && typeof content === "string"
    && !content.trim()
    && !hasAttachments(data);
}

export function getUndoBoundaryEventId(event: unknown): string | undefined {
  if (eventType(event) !== "user.message" || getSkillSource(event) || isSdkAgentUserMessage(event)) {
    return undefined;
  }
  if (!isVisibleMessageEvent(event)) return undefined;
  return getRawEventId(event);
}

function getSkillLabel(source: string, content: string): string {
  // agent-text-audit: format (the skill-context tag the runtime inserts)
  const fromContext = content.match(/<skill-context\s+name="([^"]+)"/);
  if (fromContext?.[1]?.trim()) return fromContext[1].trim();
  const fromSource = source.replace(/^skill[-:]?/i, "").trim();
  return fromSource || "skill";
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

export function isQuietIntervalDeferEvent(event: unknown, expectedDeferId?: string): boolean {
  const metadata = parseDeferMetadata(getUserMessageContent(event));
  return metadata?.kind === "interval"
    && metadata.attentionMode === "quiet"
    && (expectedDeferId === undefined || metadata.deferId === expectedDeferId);
}

export function isVisibleMessageEvent(event: unknown, sessionId?: string): boolean {
  const data = eventData(event);
  const type = eventType(event);

  if (type === "user.message") {
    if (isAgentInjectedSystemMessage(event) || isSdkAgentUserMessage(event) || isAutopilotContinuationEvent(event)) return false;
    return Boolean(messageText(data).trim() || hasAttachments(data));
  }

  if (type === "assistant.message") {
    return !data?.parentToolCallId && Boolean((stringField(data, "content") ?? "").trim());
  }

  if (type === "tool.execution_start") {
    const toolName = toolNameOf(data);
    return Boolean(data?.toolCallId) && !isHiddenTool(toolName, data?.arguments, sessionId);
  }

  if (extractTerminalCompletion(event)) {
    return true;
  }

  return false;
}

/** Main-agent thinking: a transcript entry both counters must count, but it never marks unread. */
export function getVisibleReasoningText(event: unknown): string | undefined {
  if (eventType(event) !== "assistant.message") return undefined;
  const data = eventData(event);
  if (data?.parentToolCallId || getSdkAgentId(event)) return undefined;
  const text = data?.reasoningText;
  return typeof text === "string" && text.trim() ? text : undefined;
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
  event: unknown,
  toolName: string | undefined,
  sessionId?: string,
): TransformedVisual | undefined {
  const data = eventData(event);
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

/** The runtime's built-in tool that generates and edits images. */
export const IMAGE_GENERATION_TOOL_NAME = "image_generation";

const GENERATED_IMAGE_FILE_RE = /^[\w.-]+\.(?:png|jpe?g|webp)$/i;
const MAX_GENERATED_IMAGE_ALT_CHARS = 1_000;

function listItem(list: unknown, index: number): Record<string, unknown> | undefined {
  return Array.isArray(list) ? asRecord(list[index]) : undefined;
}

/** Decoded size of base64 data, which is what the card shows as the file size. */
function base64DecodedBytes(data: unknown): number | undefined {
  if (typeof data !== "string" || !data) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Image tool results as cards; only images in the session's images/ folder can be served. */
export function getGeneratedImageVisuals(
  event: unknown,
  toolName: string | undefined,
  sessionId?: string,
  args?: unknown,
): TransformedVisual[] {
  const data = eventData(event);
  if (toolName !== IMAGE_GENERATION_TOOL_NAME || !sessionId || data?.success !== true) return [];
  const result = asRecord(data?.result);
  const images = asRecord(asRecord(result?.structuredContent)?.imageGeneration)?.images;
  if (!Array.isArray(images)) return [];
  const toolArgs = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const edited = Array.isArray(toolArgs.input_images) && toolArgs.input_images.length > 0;
  const prompt = typeof toolArgs.prompt === "string" ? toolArgs.prompt.trim() : "";
  const visuals: TransformedVisual[] = [];
  for (const item of images) {
    const image = asRecord(item);
    const savedPath = stringField(image, "savedPath") ?? "";
    // win32 path functions split on both separators, so this reads paths saved on any host.
    const fileName = winPath.basename(savedPath);
    const folder = winPath.dirname(savedPath);
    if (
      !GENERATED_IMAGE_FILE_RE.test(fileName)
      || winPath.basename(folder) !== "images"
      || winPath.basename(winPath.dirname(folder)) !== sessionId
    ) {
      continue;
    }
    const contentIndex = typeof image?.contentIndex === "number" ? image.contentIndex : undefined;
    const content = contentIndex === undefined ? undefined : listItem(result?.contents, contentIndex);
    const binary = contentIndex === undefined ? undefined : listItem(result?.binaryResultsForLlm, contentIndex);
    const size = base64DecodedBytes(content?.data)
      ?? (typeof binary?.byteLength === "number" ? binary.byteLength : undefined)
      ?? base64DecodedBytes(binary?.data)
      ?? 0;
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(fileName)}`;
    visuals.push({
      artifactId: `generated-${fileName}`,
      kind: "image",
      title: edited ? "Edited image" : "Generated image",
      displayName: fileName,
      mimeType: stringField(image, "mimeType") ?? "image/png",
      size,
      url,
      downloadUrl: `${url}?download`,
      ...(prompt ? { altText: prompt.slice(0, MAX_GENERATED_IMAGE_ALT_CHARS) } : {}),
    });
  }
  return visuals;
}

/** The visual cards a completed tool call adds to the chat, in the order they are shown. */
export function getToolCompletionVisuals(
  event: unknown,
  toolName: string | undefined,
  sessionId?: string,
  args?: unknown,
): TransformedVisual[] {
  if (toolName === "publish_visual") {
    const visual = getVisualArtifactFromToolCompletion(event, toolName, sessionId);
    return visual ? [visual] : [];
  }
  return getGeneratedImageVisuals(event, toolName, sessionId, args);
}

export function getVisibleEventTimestamp(event: unknown, sessionId?: string): string | undefined {
  if (!isVisibleMessageEvent(event, sessionId)) return undefined;
  return messageTimestamp(event);
}

/** Fold state of {@link createVisibleActivityTracker}, so incremental scans can resume. */
export interface VisibleActivityTrackerState {
  openVisibleToolCallIds: string[];
  lastVisibleActivityAt?: string;
  quietTurn: boolean;
  pendingTerminalCompletionActivity: boolean;
}

export function createVisibleActivityTracker(
  sessionId?: string,
  initialState?: VisibleActivityTrackerState,
) {
  const openVisibleToolCallIds = new Set<string>(initialState?.openVisibleToolCallIds ?? []);
  let lastVisibleActivityAt: string | undefined = initialState?.lastVisibleActivityAt;
  let quietTurn = initialState?.quietTurn ?? false;
  let pendingTerminalCompletionActivity = initialState?.pendingTerminalCompletionActivity ?? false;

  function observe(event: unknown): string | undefined {
    const type = eventType(event);
    const data = eventData(event);
    const toolCallId = stringField(data, "toolCallId");
    if (type === "user.message") {
      if (isSdkAgentUserMessage(event)) return lastVisibleActivityAt;
      if (quietTurn && !isSdkUserAuthoredMessage(event)) return lastVisibleActivityAt;
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

    if (
      type === "tool.execution_start"
      && extractTerminalCompletionFromToolCall(data?.toolName ?? data?.name, data?.arguments)
    ) {
      pendingTerminalCompletionActivity = true;
      return lastVisibleActivityAt;
    }

    const timestamp = getVisibleEventTimestamp(event, sessionId);
    if (timestamp) {
      lastVisibleActivityAt = timestamp;
      if (extractTerminalCompletion(event)) pendingTerminalCompletionActivity = false;
      if (type === "tool.execution_start" && toolCallId) {
        openVisibleToolCallIds.add(toolCallId);
      }
      return lastVisibleActivityAt;
    }

    if (type === "tool.execution_complete" && toolCallId && openVisibleToolCallIds.has(toolCallId)) {
      const completedAt = eventTimestamp(event);
      if (completedAt) lastVisibleActivityAt = completedAt;
      openVisibleToolCallIds.delete(toolCallId);
      return lastVisibleActivityAt;
    }

    if (isTurnTerminalEvent(event) && openVisibleToolCallIds.size > 0) {
      const terminalAt = eventTimestamp(event);
      if (terminalAt) lastVisibleActivityAt = terminalAt;
      openVisibleToolCallIds.clear();
    }
    if (isTurnTerminalEvent(event) && pendingTerminalCompletionActivity) {
      const terminalAt = messageTimestamp(event);
      if (terminalAt) lastVisibleActivityAt = terminalAt;
      pendingTerminalCompletionActivity = false;
    }
    return lastVisibleActivityAt;
  }

  return {
    observe,
    getLastVisibleActivityAt: () => lastVisibleActivityAt,
    getState: (): VisibleActivityTrackerState => ({
      openVisibleToolCallIds: [...openVisibleToolCallIds],
      ...(lastVisibleActivityAt ? { lastVisibleActivityAt } : {}),
      quietTurn,
      pendingTerminalCompletionActivity,
    }),
  };
}

export function getLastVisibleActivityAt(events: readonly unknown[], sessionId?: string): string | undefined {
  const tracker = createVisibleActivityTracker(sessionId);
  for (const event of events) {
    tracker.observe(event);
  }
  return tracker.getLastVisibleActivityAt();
}

/** State just before an event; resuming from it transforms the rest exactly like a full pass. */
export interface TranscriptCursor {
  turnIndex: number;
  subAgentTurnIndex: number;
  activeTurnId?: string;
  activeTurnInstanceId?: string;
  activeTurnStartedAt?: string;
  activeUndoEventId?: string;
  pendingTerminalCompletion?: TerminalCompletion;
  /** Sub-agent launches that have started and not yet completed or failed. */
  activeSubAgentToolCallIds: string[];
  /** The log is known to stamp its agents' turns with their agent; see agent-event-ownership.ts. */
  agentTurnsStamped: boolean;
  /** Turn guessed as an agent's; if the log later proves stamped, this cursor no longer matches. */
  guessedAgentTurn: boolean;
  /** The open turn of each agent whose turns are stamped, keyed by its events' owner. */
  agentTurns: Record<string, { turnId: string; turnInstanceId: string }>;
}

export function createTranscriptCursor(): TranscriptCursor {
  return {
    turnIndex: 0,
    subAgentTurnIndex: 0,
    activeSubAgentToolCallIds: [],
    agentTurnsStamped: false,
    guessedAgentTurn: false,
    agentTurns: {},
  };
}

export function cloneTranscriptCursor(cursor: TranscriptCursor): TranscriptCursor {
  return {
    ...cursor,
    activeSubAgentToolCallIds: [...cursor.activeSubAgentToolCallIds],
    agentTurns: { ...cursor.agentTurns },
  };
}

/** `agentOwners` must have seen the event already; false for events that never move the cursor. */
export function advanceTranscriptCursor(cursor: TranscriptCursor, event: unknown, agentOwners: AgentEventOwners): boolean {
  const data = eventData(event);
  const type = eventType(event);
  const toolCallId = stringField(data, "toolCallId");
  const firstStamp = !cursor.agentTurnsStamped && showsAgentTurnsAreStamped(event);
  if (firstStamp) cursor.agentTurnsStamped = true;
  if (type === "subagent.started" && toolCallId) {
    if (!cursor.activeSubAgentToolCallIds.includes(toolCallId)) cursor.activeSubAgentToolCallIds.push(toolCallId);
    return true;
  }
  if ((type === "subagent.completed" || type === "subagent.failed") && toolCallId) {
    cursor.activeSubAgentToolCallIds = cursor.activeSubAgentToolCallIds.filter((id) => id !== toolCallId);
    return true;
  }
  if (type === "assistant.turn_start") {
    // Stamped turns are tracked per agent, so the main agent's turn is never taken for theirs.
    const agentOwner = cursor.agentTurnsStamped ? agentOwners.ownerOf(event) : undefined;
    if (agentOwner !== undefined) {
      cursor.subAgentTurnIndex += 1;
      cursor.agentTurns[agentOwner] = {
        turnId: `subagent-turn-${cursor.subAgentTurnIndex}`,
        turnInstanceId: getAssistantTurnInstanceId(event, `subagent-turn-instance-${cursor.subAgentTurnIndex}`),
      };
    } else if (!cursor.agentTurnsStamped && cursor.activeSubAgentToolCallIds.length > 0) {
      // Unstamped runtime: with an agent running, take the turn for an agent's.
      cursor.guessedAgentTurn = true;
      cursor.subAgentTurnIndex += 1;
      cursor.activeTurnId = `subagent-turn-${cursor.subAgentTurnIndex}`;
      cursor.activeTurnInstanceId = getAssistantTurnInstanceId(event, `subagent-turn-instance-${cursor.subAgentTurnIndex}`);
    } else {
      cursor.turnIndex += 1;
      cursor.activeTurnId = getSdkTurnId(event) ?? `turn-${cursor.turnIndex}`;
      cursor.activeTurnInstanceId = getAssistantTurnInstanceId(event, `turn-instance-${cursor.turnIndex}`);
      cursor.activeTurnStartedAt = eventTimestamp(event);
    }
    return true;
  }
  if (extractTerminalCompletion(event) || isTurnTerminalEvent(event)) {
    cursor.pendingTerminalCompletion = undefined;
    const endedAgent = cursor.agentTurnsStamped && type === "assistant.turn_end"
      ? agentOwners.ownerOf(event)
      : undefined;
    if (endedAgent !== undefined) {
      // An agent finishing a turn leaves the main agent's turn exactly as it was.
      delete cursor.agentTurns[endedAgent];
    } else {
      cursor.activeTurnId = undefined;
      cursor.activeTurnInstanceId = undefined;
      cursor.activeTurnStartedAt = undefined;
    }
    return true;
  }
  if (type === "user.message") {
    if (!isVisibleMessageEvent(event) || getSkillSource(event) || isAutopilotContinuationEvent(event)) return false;
    cursor.activeUndoEventId = getUndoBoundaryEventId(event);
    return true;
  }
  if (type === "tool.execution_start" && data?.toolCallId) {
    const completion = extractTerminalCompletionFromToolCall(data.toolName ?? data.name ?? "unknown", data.arguments);
    if (!completion) return false;
    cursor.pendingTerminalCompletion = completion;
    return true;
  }
  return firstStamp;
}

export interface TransformEventsToMessagesOptions {
  /** Cursor in effect before the first event, when `events` is a suffix of the log. */
  initialCursor?: TranscriptCursor;
}

/** Pass 1 indexes tool completion results; pass 2 emits entries in event order. */
export function transformEventsToMessages(
  events: readonly unknown[],
  sessionId?: string,
  options: TransformEventsToMessagesOptions = {},
): TransformedEntry[] {
  const entries: TransformedEntry[] = [];
  let idx = 0;
  const cursor = cloneTranscriptCursor(options.initialCursor ?? createTranscriptCursor());
  const turnDetailsByMessageId = transcriptTurnDetails(events);
  // Pass 1 tracks the same launches as the cursor, as of each event it indexes.
  const correlatingSubAgentToolCallIds = new Set<string>(cursor.activeSubAgentToolCallIds);
  const agentOwners = new AgentEventOwners();

  // Pass 1: Index tool completions and sub-agent metadata for enrichment
  const toolCompletes = new Map<string, ToolCompletionRecord>();
  const toolProgress = new Map<string, string>();
  /** Calls with no completion yet, by the agent that made them (`undefined` is the main agent). */
  const openToolCallOwners = new Map<string, string | undefined>();
  const correlator = new SubagentCorrelator();
  const toolNames = new Map<string, string>();
  const assistantForkBoundaries = getAssistantForkBoundaries(events);
  // Visual cards from tool completions (publish_visual, generated images), by tool call
  const visualResults = new Map<string, TransformedVisual[]>();
  // Arguments of image calls, which say whether an image was generated or edited
  const imageToolArgs = new Map<string, unknown>();

  for (const event of events) {
    const data = eventData(event);
    const type = eventType(event);
    const toolCallId = stringField(data, "toolCallId");
    const parentToolCallId = stringField(data, "parentToolCallId");
    agentOwners.learn(event);
    // A log that stamps its agents' turns anywhere is read that way from its first event.
    if (showsAgentTurnsAreStamped(event)) cursor.agentTurnsStamped = true;
    if (type === "tool.execution_start" && toolCallId) {
      openToolCallOwners.set(toolCallId, getSdkAgentId(event));
      toolNames.set(toolCallId, toolNameOf(data));
      if (toolNames.get(toolCallId) === IMAGE_GENERATION_TOOL_NAME) imageToolArgs.set(toolCallId, data?.arguments);
    } else if (type === "tool.execution_complete" && toolCallId) {
      // Raw data kept so pass 2 derives display text through the same resolver as the live fold.
      toolCompletes.set(toolCallId, {
        success: typeof data?.success === "boolean" ? data.success : undefined,
        data,
        timestamp: eventTimestamp(event),
        eventId: getSdkEventId(event),
      });
      correlator.completeTool(toolCallId);
      openToolCallOwners.delete(toolCallId);
      const visuals = getToolCompletionVisuals(
        event,
        toolNames.get(toolCallId),
        sessionId,
        imageToolArgs.get(toolCallId),
      );
      if (visuals.length > 0) visualResults.set(toolCallId, visuals);
    } else if ((type === "tool.execution_progress" || type === "tool.execution_partial_result") && toolCallId) {
      const nextText = type === "tool.execution_progress"
        ? data?.progressMessage
        : data?.partialOutput;
      if (typeof nextText === "string" && nextText.trim()) {
        toolProgress.set(toolCallId, nextText);
      }
    } else if (type === "subagent.started" && toolCallId) {
      correlator.startSubagent(toolCallId, getSdkAgentId(event), data);
      correlatingSubAgentToolCallIds.add(toolCallId);
    } else if (type === "subagent.failed" && toolCallId) {
      correlator.recordSubagentFailure(toolCallId, data?.error);
      correlatingSubAgentToolCallIds.delete(toolCallId);
    } else if (type === "subagent.completed" && toolCallId) {
      correlatingSubAgentToolCallIds.delete(toolCallId);
    } else if (type === "assistant.message" && parentToolCallId && data?.content) {
      correlator.recordResponse(parentToolCallId, data.content);
    } else if (type === "session.error" && getSdkAgentId(event) && !isSdkPersistenceSessionError(event)) {
      correlator.recordAgentError(getSdkAgentId(event)!, data?.message);
    } else if (type === "user.message" && isSdkAgentUserMessage(event)) {
      const agentId = getSdkAgentId(event);
      if (agentId) {
        correlator.recordInstruction(agentId, data?.content ?? data?.prompt);
      } else if (correlatingSubAgentToolCallIds.size === 1) {
        const toolCallId = [...correlatingSubAgentToolCallIds][0];
        if (toolCallId) {
          correlator.recordInstructionForToolCall(toolCallId, data?.content ?? data?.prompt);
        }
      }
    } else if (isTurnTerminalEvent(event)) {
      // Provisional; a turn end fails only its own agent's open calls, abort/shutdown fails all.
      const endedBy = getSdkAgentId(event);
      const stopsEverything = type === "abort" || type === "session.shutdown";
      for (const [toolCallId, owner] of openToolCallOwners) {
        if (!stopsEverything && owner !== endedBy) continue;
        toolCompletes.set(toolCallId, {
          success: false,
          fallbackText: correlator.resolve(toolCallId).response ?? toolProgress.get(toolCallId),
          timestamp: eventTimestamp(event),
        });
        openToolCallOwners.delete(toolCallId);
      }
    }
  }

  // The cursor owns every state change; a closing event belongs to the turn it closes.
  for (const event of events) {
    const data = eventData(event);
    const type = eventType(event);
    const { activeTurnId: closingTurnId, activeTurnInstanceId: closingTurnInstanceId } = cursor;
    const pendingTerminalCompletion = cursor.pendingTerminalCompletion;
    advanceTranscriptCursor(cursor, event, agentOwners);
    const { activeTurnId, activeTurnInstanceId, activeTurnStartedAt, activeUndoEventId } = cursor;

    if (extractTerminalCompletion(event) || isTurnTerminalEvent(event)) {
      const recorded = getTranscriptCompletion(event, pendingTerminalCompletion);
      if (recorded) {
        entries.push({
          id: `entry-${idx++}`,
          type: "completion",
          ...(recorded.sourceEventId ? { sourceEventId: recorded.sourceEventId } : {}),
          completion: recorded.completion,
          content: recorded.completion.content,
          timestamp: recorded.timestamp,
          ...(closingTurnId ? { turnId: closingTurnId } : {}),
          ...(closingTurnInstanceId ? { turnInstanceId: closingTurnInstanceId } : {}),
        });
      }
    } else if (type === "user.message") {
      if (isAgentInjectedSystemMessage(event) && !isCustomContinuationMessage(event)) continue;
      if (isSdkAgentUserMessage(event)) continue;
      if (isAutopilotContinuationEvent(event)) {
        entries.push({
          id: `entry-${idx++}`,
          type: "continuation",
          ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          timestamp: messageTimestamp(event),
        });
        continue;
      }
      const content = messageText(data);
      if (!content.trim() && !hasAttachments(data)) continue;
      const skillSource = getSkillSource(event);
      if (skillSource) {
        entries.push({
          id: `entry-${idx++}`,
          type: "skill",
          ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          skill: { id: skillSource, label: getSkillLabel(skillSource, content) },
          content,
          timestamp: messageTimestamp(event),
        });
        continue;
      }
      const attachments = Array.isArray(data?.attachments) ? data.attachments.filter(isRecord) : [];
      const blobAttachments = attachments.flatMap((a) => {
        const mimeType = stringField(a, "mimeType");
        return a.type === "blob" && mimeType
          ? [{ type: "blob" as const, data: stringField(a, "data"), mimeType, displayName: stringField(a, "displayName") }]
          : [];
      });
      const fileAttachments = attachments.flatMap((a) => {
        const path = stringField(a, "path");
        // win32.basename handles both "\\" and "/" paths on any host.
        return a.type === "file" && path
          ? [{ type: "file" as const, path, displayName: stringField(a, "displayName") ?? winPath.basename(path) }]
          : [];
      });
      const allAttachments = [...blobAttachments, ...fileAttachments];
      entries.push({
        id: `entry-${idx++}`,
        type: "message",
        ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
        role: "user",
        content,
        timestamp: messageTimestamp(event),
        ...(typeof data?.messageId === "string" && data.messageId ? { messageId: data.messageId } : {}),
        ...(activeUndoEventId ? { undoEventId: activeUndoEventId } : {}),
        ...(allAttachments.length ? { attachments: allAttachments } : {}),
        ...(data?.agentMode === "autopilot" ? { agentMode: "autopilot" as const } : {}),
      });
    } else if (type === "assistant.message") {
      if (data?.parentToolCallId) continue; // sub-agent response text, not a top-level message
      const reasoningText = getVisibleReasoningText(event);
      if (reasoningText) {
        const messageEventId = getSdkEventId(event);
        entries.push({
          id: `entry-${idx++}`,
          type: "reasoning",
          content: reasoningText,
          timestamp: messageTimestamp(event),
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
          ...(activeTurnInstanceId ? { turnInstanceId: activeTurnInstanceId } : {}),
          reasoning: {
            ...(messageEventId ? { messageEventId } : {}),
            ...(activeTurnStartedAt ? { startedAt: activeTurnStartedAt } : {}),
          },
        });
      }
      const content = stringField(data, "content") ?? "";
      if (content.trim()) {
        const rawEventId = getRawEventId(event);
        const forkBoundaryEventId = rawEventId ? assistantForkBoundaries.get(rawEventId) : undefined;
        const progressUpdate = isToolAccompanyingProgress(data?.toolRequests);
        entries.push({
          id: `entry-${idx++}`,
          type: "message",
          ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          role: "assistant",
          content,
          ...(typeof data?.model === "string" && data.model ? { model: data.model } : {}),
          ...(progressUpdate ? { progressUpdate: true } : {}),
          ...(rawEventId && turnDetailsByMessageId.has(rawEventId)
            ? { turnDetails: turnDetailsByMessageId.get(rawEventId) }
            : {}),
          timestamp: messageTimestamp(event),
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
          ...(activeTurnInstanceId ? { turnInstanceId: activeTurnInstanceId } : {}),
          ...(forkBoundaryEventId ? { forkBoundaryEventId } : {}),
          ...(activeUndoEventId ? { undoEventId: activeUndoEventId } : {}),
        });
      }
    } else if (type === "tool.execution_start") {
      const toolCallId = stringField(data, "toolCallId");
      if (!data || !toolCallId) continue;
      const toolName = toolNameOf(data);
      const terminalCompletion = extractTerminalCompletionFromToolCall(toolName, data.arguments);
      if (terminalCompletion) continue;
      if (isHiddenTool(toolName, data.arguments, sessionId)) continue;
      const complete = toolCompletes.get(toolCallId);
      const resolution = correlator.resolve(toolCallId);
      const outcome = resolveToolOutcome(resolution, complete, toolName);
      // An agent's step belongs to that agent's turn, not to whichever turn began most recently.
      const agentOwner = cursor.agentTurnsStamped ? agentOwners.ownerOf(event) : undefined;
      const stepTurn = agentOwner !== undefined
        ? cursor.agentTurns[agentOwner]
        : { turnId: activeTurnId, turnInstanceId: activeTurnInstanceId };
      const parentToolCallId = agentOwners.launchOf(event);
      entries.push({
        id: `entry-${idx++}`,
        type: "tool",
        ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
        ...(stepTurn?.turnId ? { turnId: stepTurn.turnId } : {}),
        ...(stepTurn?.turnInstanceId ? { turnInstanceId: stepTurn.turnInstanceId } : {}),
        toolCall: {
          toolCallId,
          name: outcome.displayName,
          args: data.arguments,
          result: outcome.result,
          progressText: toolProgress.get(toolCallId),
          success: outcome.success,
          parentToolCallId,
          isSubAgent: outcome.isSubAgent || undefined,
          agentInstructions: outcome.isSubAgent
            ? buildSubagentInstructions(data.arguments, resolution.instructions)
            : undefined,
          startedAt: eventTimestamp(event),
          completedAt: complete?.timestamp,
        },
      });
      // Visual cards the call produced follow its tool entry.
      for (const visual of visualResults.get(toolCallId) ?? []) {
        entries.push({
          id: `entry-${idx++}`,
          type: "visual",
          ...(complete?.eventId ? { sourceEventId: complete.eventId } : {}),
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
          ...(activeTurnInstanceId ? { turnInstanceId: activeTurnInstanceId } : {}),
          visual,
          timestamp: complete?.timestamp ?? eventTimestamp(event),
        });
      }
    }
  }

  return entries;
}
