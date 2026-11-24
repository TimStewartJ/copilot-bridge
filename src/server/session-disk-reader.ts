import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { readJsonlLines, scanJsonlRecords, withoutCarriageReturn } from "./jsonl-lines.js";
import {
  advanceTranscriptCursor,
  cloneTranscriptCursor,
  createTranscriptCursor,
  createVisibleActivityTracker,
  getLastVisibleActivityAt,
  getToolCompletionVisuals,
  getVisibleReasoningText,
  IMAGE_GENERATION_TOOL_NAME,
  isAutopilotContinuationEvent,
  isVisibleMessageEvent,
  projectTranscriptEvent,
  transformEventsToMessages,
  TRANSCRIPT_EVENT_TYPES,
  type TranscriptCursor,
  type TransformedEntry,
  type VisibleActivityTrackerState,
} from "./event-transform.js";
import {
  extractTerminalCompletion,
  extractTerminalCompletionFromToolCall,
  TERMINAL_TURN_EVENT_TYPES,
} from "../shared/terminal-completion.js";
import type { EventBusRegistry } from "./event-bus.js";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import { parseWorkspaceYamlSessionName } from "./session-workspace-yaml.js";
import type { SessionHistoryCoverage } from "../shared/session-stream.js";
import {
  getSdkEventId,
  getSdkTurnId,
  isSdkAgentUserMessage,
  isNonTerminalSessionError,
} from "./sdk-event-identity.js";
import { AgentEventOwners } from "./agent-event-ownership.js";
import { projectSearchableMessage, type SearchableMessage } from "./search-message-projection.js";
import {
  TranscriptAgentFold,
  cloneTranscriptAgentFoldState,
  createTranscriptAgentFoldState,
  type TranscriptAgentFoldState,
} from "./transcript-agent-fold.js";
import type { TranscriptAgent } from "../shared/transcript-agents.js";
import { advanceTranscriptTurnBoundary, type TranscriptTurnBoundary } from "./transcript-turn-details.js";
import { isRecord } from "../shared/is-record.js";

const RECENT_MESSAGES_INITIAL_TAIL_BYTES = 256 * 1024;
const RECENT_MESSAGES_SINGLE_READ_MAX_BYTES = 1024 * 1024;
const RECENT_MESSAGES_MAX_TAIL_BYTES = 8 * 1024 * 1024;
const EVENT_LOG_STATS_SCAN_CHUNK_BYTES = 256 * 1024;
/** Small on purpose: folds carry turn checkpoints and few sessions are read at once. */
const EVENT_LOG_STATS_CACHE_MAX_ENTRIES = 32;
const EVENT_LOG_STATS_CACHE_VERSION = 7;
/** Bytes hashed at the head and at the resume point to detect event-log rewrites. */
const EVENT_LOG_FINGERPRINT_BYTES = 4 * 1024;
/** Backstop bound on retained cursor checkpoints when the log has very short turns. */
const EVENT_LOG_TURN_CHECKPOINT_MAX = 2048;
const SESSION_LIST_READ_CONCURRENCY = 32;

/** Every event the transcript reads names its type, so any other line can be skipped unparsed. */
const MESSAGE_RELEVANT_EVENT_MARKERS = [...TRANSCRIPT_EVENT_TYPES];

const TURN_TERMINAL_EVENT_TYPES = TERMINAL_TURN_EVENT_TYPES;
const isTurnTerminalEvent = (event: unknown): boolean => {
  const type = eventType(event);
  return typeof type === "string" && TURN_TERMINAL_EVENT_TYPES.has(type) && !isNonTerminalSessionError(event);
};

function eventType(event: unknown): unknown {
  return isRecord(event) ? event.type : undefined;
}

function eventData(event: unknown): Record<string, unknown> | undefined {
  return isRecord(event) && isRecord(event.data) ? event.data : undefined;
}

export interface SessionDiskReaderDeps {
  copilotHome?: string;
  sessionMetaStore?: SessionMetaStore;
  eventBusRegistry: Pick<EventBusRegistry, "getBus">;
  resolveEffectiveSessionCwdFromWorkspaceYaml(
    sessionId: string,
    content: string,
  ): string | undefined | Promise<string | undefined>;
  recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void;
  persistLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt?: string): void;
}

export interface ReadMessagesFromDiskResult {
  messages: TransformedEntry[];
  total: number;
  hasMore: boolean;
  lastVisibleActivityAt?: string;
  coverage: SessionHistoryCoverage;
  /** All sub-agents in the log, so a step shows under its agent even if launched off-window. */
  agents: TranscriptAgent[];
}

export interface ReadMessagesAroundEventResult extends ReadMessagesFromDiskResult {
  targetOffset: number;
  startOffset: number;
  endOffset: number;
  hasNewer: boolean;
}

export class SessionMessageNotFoundError extends Error {
  constructor(
    readonly sessionId: string,
    readonly sourceEventId: string,
  ) {
    super(`Message event ${sourceEventId} was not found in session ${sessionId}`);
    this.name = "SessionMessageNotFoundError";
  }
}

function emptyReadResult(): ReadMessagesFromDiskResult {
  return { messages: [], total: 0, hasMore: false, coverage: {}, agents: [] };
}

interface EventLogStats {
  eventCount: number;
  candidateEventCount: number;
  malformedCandidateCount: number;
  totalEntries: number;
  lastVisibleActivityAt?: string;
  /** Transcript cursor in effect just before the requested offset; undefined once pruned. */
  cursor?: TranscriptCursor;
  turnStartOffset?: number;
  hasUsageRecords: boolean;
  coverage: SessionHistoryCoverage;
  agents: TranscriptAgent[];
}

interface TailCandidateEvents {
  events: unknown[];
  bytesRead: number;
  fileSize: number;
  mtimeMs: number;
  startOffset: number;
  readFullFile: boolean;
  malformedCandidateCount: number;
  fullContentBuffer?: Buffer;
}

interface CursorCheckpoint {
  /** Byte offset of the line whose effect produced `cursor`. */
  offset: number;
  cursor: TranscriptCursor;
  turnStartOffset?: number;
}

/** Serializable fold state, apart from the scanner so a grown log resumes from its last offset. */
interface EventLogStatsScannerState {
  eventCount: number;
  candidateEventCount: number;
  malformedCandidateCount: number;
  totalEntries: number;
  openVisibleToolCallIds: string[];
  /** Visible calls that may add visual cards when they complete, as [toolCallId, toolName]. */
  visibleVisualToolCalls: Array<[string, string]>;
  pendingTerminalCompletionEntry: boolean;
  latestEventId?: string;
  latestTurnId?: string;
  latestTerminalEventId?: string;
  /** Counts every turn start, as `getSessionHistoryCoverage` numbers turns without an id. */
  turnIndex: number;
  cursor: TranscriptCursor;
  turnBoundary?: TranscriptTurnBoundary;
  turnStartOffset?: number;
  hasUsageRecords: boolean;
  /** Collapsed state for every checkpoint older than the largest possible tail window. */
  baseCheckpoint: CursorCheckpoint;
  checkpoints: CursorCheckpoint[];
  activity: VisibleActivityTrackerState;
  agents: TranscriptAgentFoldState;
  /** What the cursor's {@link AgentEventOwners} has learnt, so a resumed scan files turns alike. */
  agentOwners: Array<[string, string]>;
}

export interface EventLogStatsCacheEntry {
  eventsPath: string;
  sessionId: string;
  /** Byte offset up to (and including) the last complete line folded into `state`. */
  scannedBytes: number;
  state: EventLogStatsScannerState;
  /** sha1 over the head, midpoint, and end of the scanned region; detects in-place rewrites. */
  fingerprint: string;
  /** `dev:ino` of the scanned file, so a replaced (not appended) log is never resumed. */
  fileId: string;
}

const eventLogStatsCache = new Map<string, EventLogStatsCacheEntry>();
/** Bumped by {@link clearEventLogStatsCache} so in-flight scans cannot republish stale folds. */
let eventLogStatsCacheGeneration = 0;

/** Durable fold cache so the first open after a restart resumes from the last offset. */
export interface EventLogStatsPersistence {
  load(eventsPath: string, sessionId: string): EventLogStatsCacheEntry | undefined;
  save(entry: EventLogStatsCacheEntry): void;
  delete(sessionId: string): void;
  clear(): void;
}

let eventLogStatsPersistence: EventLogStatsPersistence | undefined;

export function setEventLogStatsPersistence(persistence: EventLogStatsPersistence | undefined): void {
  eventLogStatsPersistence = persistence;
}

/** Yield to the event loop after this much synchronous folding so other work interleaves. */
const EVENT_LOG_STATS_SCAN_SLICE_MS = 12;
/** Sliced cold scans still starve the loop when many run at once (after a restart), so cap them. */
const EVENT_LOG_STATS_SCAN_MAX_CONCURRENT = 2;
/** Scans shorter than this never wait for a slot: they are cheaper than the queueing. */
const EVENT_LOG_STATS_SCAN_GATE_MIN_BYTES = 4 * 1024 * 1024;

let activeEventLogStatsScans = 0;
const eventLogStatsScanWaiters: Array<() => void> = [];

async function acquireEventLogStatsScanSlot(): Promise<() => void> {
  if (activeEventLogStatsScans < EVENT_LOG_STATS_SCAN_MAX_CONCURRENT) {
    activeEventLogStatsScans += 1;
  } else {
    await new Promise<void>((resolve) => eventLogStatsScanWaiters.push(resolve));
    activeEventLogStatsScans += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeEventLogStatsScans -= 1;
    const next = eventLogStatsScanWaiters.shift();
    if (next) next();
  };
}

/** Test hook: report scan concurrency so the gate can be asserted without timing games. */
export function getEventLogStatsScanConcurrencyForTests(): { active: number; waiting: number } {
  return { active: activeEventLogStatsScans, waiting: eventLogStatsScanWaiters.length };
}

function getEventLogStatsCacheKey(eventsPath: string, sessionId: string): string {
  return `${EVENT_LOG_STATS_CACHE_VERSION}\0${eventsPath}\0${sessionId}`;
}

function pruneEventLogStatsCache(): void {
  while (eventLogStatsCache.size > EVENT_LOG_STATS_CACHE_MAX_ENTRIES) {
    const oldestKey = eventLogStatsCache.keys().next().value;
    if (oldestKey === undefined) return;
    eventLogStatsCache.delete(oldestKey);
  }
}

function getCachedEventLogStatsEntry(
  eventsPath: string,
  sessionId: string,
): EventLogStatsCacheEntry | undefined {
  const key = getEventLogStatsCacheKey(eventsPath, sessionId);
  const entry = eventLogStatsCache.get(key);
  if (entry) {
    eventLogStatsCache.delete(key);
    eventLogStatsCache.set(key, entry);
    return entry;
  }
  if (!eventLogStatsPersistence) return undefined;
  try {
    const persisted = eventLogStatsPersistence.load(eventsPath, sessionId);
    if (!persisted) return undefined;
    eventLogStatsCache.set(key, persisted);
    pruneEventLogStatsCache();
    return persisted;
  } catch {
    return undefined;
  }
}

function setCachedEventLogStatsEntry(entry: EventLogStatsCacheEntry): void {
  const key = getEventLogStatsCacheKey(entry.eventsPath, entry.sessionId);
  eventLogStatsCache.delete(key);
  eventLogStatsCache.set(key, entry);
  pruneEventLogStatsCache();
  if (!eventLogStatsPersistence) return;
  try {
    eventLogStatsPersistence.save(entry);
  } catch {
    // Durable folds are an optimization; a failed write must never fail a read.
  }
}

export function clearEventLogStatsCache(sessionId?: string): void {
  eventLogStatsCacheGeneration += 1;
  if (!sessionId) {
    eventLogStatsCache.clear();
    try { eventLogStatsPersistence?.clear(); } catch { /* best-effort */ }
    return;
  }

  for (const [key, entry] of eventLogStatsCache) {
    if (entry.sessionId === sessionId) eventLogStatsCache.delete(key);
  }
  try { eventLogStatsPersistence?.delete(sessionId); } catch { /* best-effort */ }
}

function lineMayAffectMessageTransform(line: string): boolean {
  return MESSAGE_RELEVANT_EVENT_MARKERS.some((marker) => line.includes(marker));
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function getToolCallId(event: unknown): string | undefined {
  const toolCallId = eventData(event)?.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function getToolName(event: unknown): string {
  const data = eventData(event);
  const name = data?.toolName ?? data?.name;
  return typeof name === "string" ? name : "unknown";
}

/** Parses a tail window; events the transcript skips keep their envelope, as any can be a fork. */
function parseTailEvents(content: string): {
  events: unknown[];
  malformedCandidateCount: number;
} {
  const events: unknown[] = [];
  let malformedCandidateCount = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(projectTranscriptEvent(JSON.parse(line)));
    } catch {
      malformedCandidateCount += 1;
    }
  }

  return { events, malformedCandidateCount };
}

function reindexEntries(entries: TransformedEntry[], startIndex: number): TransformedEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    id: `entry-${startIndex + index}`,
  }));
}

async function readTailCandidateEvents(
  eventsPath: string,
  sessionId: string,
  limit: number,
  minimumBytes = 0,
): Promise<TailCandidateEvents> {
  const fileStat = await stat(eventsPath);
  const fileSize = fileStat.size;
  if (fileSize === 0) {
    return {
      events: [],
      bytesRead: 0,
      fileSize,
      mtimeMs: fileStat.mtimeMs,
      startOffset: 0,
      readFullFile: true,
      malformedCandidateCount: 0,
      fullContentBuffer: Buffer.alloc(0),
    };
  }

  let bytesToRead = fileSize <= RECENT_MESSAGES_SINGLE_READ_MAX_BYTES
    ? fileSize
    : Math.min(fileSize, Math.max(minimumBytes, RECENT_MESSAGES_INITIAL_TAIL_BYTES));
  const maxTailBytes = Math.min(fileSize, RECENT_MESSAGES_MAX_TAIL_BYTES);
  let latest: TailCandidateEvents | undefined;
  const file = await open(eventsPath, "r");

  try {
    while (true) {
      const position = Math.max(0, fileSize - bytesToRead);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
      let contentBuffer = buffer.subarray(0, bytesRead);
      let startOffset = position;
      if (position > 0) {
        const firstNewline = contentBuffer.indexOf(0x0a);
        if (firstNewline >= 0) {
          contentBuffer = contentBuffer.subarray(firstNewline + 1);
          startOffset = position + firstNewline + 1;
        } else {
          contentBuffer = Buffer.alloc(0);
          startOffset = position + bytesRead;
        }
      }
      const parsed = parseTailEvents(contentBuffer.toString("utf-8"));
      latest = {
        events: parsed.events,
        bytesRead,
        fileSize,
        mtimeMs: fileStat.mtimeMs,
        startOffset,
        readFullFile: position === 0,
        malformedCandidateCount: parsed.malformedCandidateCount,
        ...(position === 0 ? { fullContentBuffer: contentBuffer } : {}),
      };

      const transformedCount = transformEventsToMessages(parsed.events, sessionId).length;
      if (position === 0 || transformedCount >= limit || bytesToRead >= maxTailBytes) {
        return latest;
      }
      bytesToRead = Math.min(maxTailBytes, bytesToRead * 2);
    }
  } finally {
    await file.close();
  }
}

function createEventLogStatsScannerState(agentTurnsStamped = false): EventLogStatsScannerState {
  const cursor = { ...createTranscriptCursor(), agentTurnsStamped };
  return {
    eventCount: 0,
    candidateEventCount: 0,
    malformedCandidateCount: 0,
    totalEntries: 0,
    openVisibleToolCallIds: [],
    visibleVisualToolCalls: [],
    pendingTerminalCompletionEntry: false,
    turnIndex: 0,
    cursor,
    hasUsageRecords: false,
    baseCheckpoint: { offset: -1, cursor: cloneTranscriptCursor(cursor) },
    checkpoints: [],
    activity: {
      openVisibleToolCallIds: [],
      quietTurn: false,
      pendingTerminalCompletionActivity: false,
    },
    agents: createTranscriptAgentFoldState(),
    agentOwners: [],
  };
}

function cloneEventLogStatsScannerState(
  state: EventLogStatsScannerState,
): EventLogStatsScannerState {
  return {
    ...state,
    openVisibleToolCallIds: [...state.openVisibleToolCallIds],
    visibleVisualToolCalls: state.visibleVisualToolCalls.map(([id, name]) => [id, name]),
    cursor: cloneTranscriptCursor(state.cursor),
    baseCheckpoint: { ...state.baseCheckpoint, cursor: cloneTranscriptCursor(state.baseCheckpoint.cursor) },
    checkpoints: state.checkpoints.map((checkpoint) => ({ ...checkpoint, cursor: cloneTranscriptCursor(checkpoint.cursor) })),
    activity: {
      ...state.activity,
      openVisibleToolCallIds: [...state.activity.openVisibleToolCallIds],
    },
    agents: cloneTranscriptAgentFoldState(state.agents),
    agentOwners: [...state.agentOwners],
  };
}

/** Must stay resumable: folding from an offset onto saved state equals a full scan. */
function createEventLogStatsScanner(sessionId: string, initialState?: EventLogStatsScannerState) {
  const state = initialState ?? createEventLogStatsScannerState();
  const openVisibleToolCallIds = new Set(state.openVisibleToolCallIds);
  const visibleVisualToolCalls = new Map(state.visibleVisualToolCalls);
  const visibleActivityTracker = createVisibleActivityTracker(sessionId, state.activity);
  const agentFold = new TranscriptAgentFold(state.agents);
  const agentOwners = new AgentEventOwners(state.agentOwners);

  const processLine = (lineBuffer: Buffer, lineStartOffset: number): void => {
    const line = withoutCarriageReturn(lineBuffer).toString("utf-8").trim();
    if (!line) return;
    state.eventCount += 1;
    if (!lineMayAffectMessageTransform(line)) return;

    state.candidateEventCount += 1;
    let event: unknown;
    try {
      // Projected as a whole-history read projects it, so both fold exactly the same events.
      event = projectTranscriptEvent(JSON.parse(line));
    } catch {
      state.malformedCandidateCount += 1;
      return;
    }

    visibleActivityTracker.observe(event);
    agentFold.observe(event);
    agentOwners.learn(event);
    const type = eventType(event);
    const eventId = getSdkEventId(event);
    if (eventId) state.latestEventId = eventId;
    if (type === "assistant.turn_start") {
      state.turnIndex += 1;
      state.latestTurnId = getSdkTurnId(event) ?? `turn-${state.turnIndex}`;
    }
    if (isTurnTerminalEvent(event) && eventId) state.latestTerminalEventId = eventId;
    const turnBoundary = advanceTranscriptTurnBoundary(state.turnBoundary, event);
    if (type === "user.message" && turnBoundary !== state.turnBoundary) {
      state.turnStartOffset = turnBoundary ? lineStartOffset : undefined;
    }
    state.turnBoundary = turnBoundary;
    if (type === "session.usage_record") state.hasUsageRecords = true;
    if (advanceTranscriptCursor(state.cursor, event, agentOwners)) {
      state.checkpoints.push({
        offset: lineStartOffset,
        cursor: cloneTranscriptCursor(state.cursor),
        turnStartOffset: state.turnStartOffset,
      });
    }
    if (
      type === "tool.execution_start"
      && extractTerminalCompletionFromToolCall(getToolName(event), eventData(event)?.arguments)
    ) {
      state.pendingTerminalCompletionEntry = true;
    }

    // Thinking is an entry of its own, ahead of the message entry the same event may also yield.
    if (getVisibleReasoningText(event)) state.totalEntries += 1;
    // An autopilot continuation is shown as a marker but is not visible activity.
    if (isAutopilotContinuationEvent(event)) {
      state.totalEntries += 1;
      return;
    }

    if (isVisibleMessageEvent(event, sessionId)) {
      state.totalEntries += 1;
      if (extractTerminalCompletion(event)) state.pendingTerminalCompletionEntry = false;
      if (type === "tool.execution_start") {
        const toolCallId = getToolCallId(event);
        if (toolCallId) {
          openVisibleToolCallIds.add(toolCallId);
          const toolName = getToolName(event);
          if (toolName === "publish_visual" || toolName === IMAGE_GENERATION_TOOL_NAME) {
            visibleVisualToolCalls.set(toolCallId, toolName);
          }
        }
      }
      return;
    }

    if (type === "tool.execution_complete") {
      const toolCallId = getToolCallId(event);
      if (!toolCallId) return;

      if (openVisibleToolCallIds.has(toolCallId)) {
        openVisibleToolCallIds.delete(toolCallId);
      }

      const visualToolName = visibleVisualToolCalls.get(toolCallId);
      if (visualToolName) {
        // Arguments only change a card's title, never how many there are.
        state.totalEntries += getToolCompletionVisuals(event, visualToolName, sessionId).length;
        visibleVisualToolCalls.delete(toolCallId);
      }
      return;
    }

    if (isTurnTerminalEvent(event) && state.pendingTerminalCompletionEntry) {
      state.totalEntries += 1;
      state.pendingTerminalCompletionEntry = false;
    }

    if (isTurnTerminalEvent(event) && openVisibleToolCallIds.size > 0) {
      openVisibleToolCallIds.clear();
    }
  };

  const syncState = (): EventLogStatsScannerState => {
    state.openVisibleToolCallIds = [...openVisibleToolCallIds];
    state.visibleVisualToolCalls = [...visibleVisualToolCalls];
    state.activity = visibleActivityTracker.getState();
    state.agents = agentFold.getState();
    state.agentOwners = agentOwners.entries();
    return state;
  };

  return { processLine, syncState };
}

/** Future cursors are >= scannedBytes - RECENT_MESSAGES_MAX_TAIL_BYTES, so older ones collapse. */
function pruneCursorCheckpoints(state: EventLogStatsScannerState, scannedBytes: number): void {
  const minUsefulOffset = scannedBytes - RECENT_MESSAGES_MAX_TAIL_BYTES;
  let collapseCount = 0;
  while (
    collapseCount < state.checkpoints.length
    && state.checkpoints[collapseCount]!.offset < minUsefulOffset
  ) {
    collapseCount += 1;
  }
  // Backstop for logs with very short turns, where the tail window alone bounds nothing useful.
  const overflow = state.checkpoints.length - collapseCount - EVENT_LOG_TURN_CHECKPOINT_MAX;
  if (overflow > 0) collapseCount += overflow;
  if (collapseCount === 0) return;
  state.baseCheckpoint = state.checkpoints[collapseCount - 1]!;
  state.checkpoints = state.checkpoints.slice(collapseCount);
}

/** Last checkpoint before `cursorOffset`; undefined if the backstop merged it into a later base. */
function resolveTranscriptCheckpoint(
  state: EventLogStatsScannerState,
  cursorOffset: number,
): CursorCheckpoint | undefined {
  if (state.baseCheckpoint.offset >= cursorOffset) return undefined;
  let selected = state.baseCheckpoint;
  let low = 0;
  let high = state.checkpoints.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const checkpoint = state.checkpoints[mid]!;
    if (checkpoint.offset < cursorOffset) {
      selected = checkpoint;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { ...selected, cursor: cloneTranscriptCursor(selected.cursor) };
}

function buildEventLogStats(
  state: EventLogStatsScannerState,
  cursorOffset: number,
): EventLogStats {
  const checkpoint = resolveTranscriptCheckpoint(state, cursorOffset);
  return {
    eventCount: state.eventCount,
    candidateEventCount: state.candidateEventCount,
    malformedCandidateCount: state.malformedCandidateCount,
    totalEntries: state.totalEntries,
    ...(state.activity.lastVisibleActivityAt
      ? { lastVisibleActivityAt: state.activity.lastVisibleActivityAt }
      : {}),
    ...(checkpoint ? { cursor: checkpoint.cursor, turnStartOffset: checkpoint.turnStartOffset } : {}),
    hasUsageRecords: state.hasUsageRecords,
    coverage: {
      ...(state.latestEventId ? { latestEventId: state.latestEventId } : {}),
      ...(state.latestTurnId ? { latestTurnId: state.latestTurnId } : {}),
      ...(state.latestTerminalEventId ? { latestTerminalEventId: state.latestTerminalEventId } : {}),
    },
    agents: new TranscriptAgentFold(state.agents).list(),
  };
}

function scanEventLogStatsFromBuffer(
  contentBuffer: Buffer,
  sessionId: string,
  cursorOffset: number,
): EventLogStats {
  const scanner = createEventLogStatsScanner(sessionId);
  let lineStart = 0;

  while (true) {
    const newlineIndex = contentBuffer.indexOf(0x0a, lineStart);
    if (newlineIndex < 0) break;
    scanner.processLine(contentBuffer.subarray(lineStart, newlineIndex), lineStart);
    lineStart = newlineIndex + 1;
  }

  if (lineStart < contentBuffer.length) {
    scanner.processLine(contentBuffer.subarray(lineStart), lineStart);
  }

  return buildEventLogStats(scanner.syncState(), cursorOffset);
}

/** Samples head, middle and end of the scanned region: appends keep them, rewrites change one. */
async function readScannedRegionFingerprint(
  file: Awaited<ReturnType<typeof open>>,
  scannedBytes: number,
): Promise<string> {
  if (scannedBytes <= 0) return "";
  const sampleLength = Math.min(EVENT_LOG_FINGERPRINT_BYTES, scannedBytes);
  const positions = [
    0,
    Math.max(0, Math.floor(scannedBytes / 2) - Math.floor(sampleLength / 2)),
    scannedBytes - sampleLength,
  ];
  const hash = createHash("sha1").update(`${scannedBytes}`);
  for (const position of positions) {
    const buffer = Buffer.alloc(sampleLength);
    const { bytesRead } = await file.read(buffer, 0, sampleLength, position);
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest("hex");
}

/** Resumes the cached fold if the log only grew; fingerprints catch rewrites (compaction, undo). */
async function scanEventLogStats(
  eventsPath: string,
  sessionId: string,
  upToBytes: number,
): Promise<{ state: EventLogStatsScannerState; resumedFrom: number; scannedBytes: number; waitedMs: number }> {
  const cached = getCachedEventLogStatsEntry(eventsPath, sessionId);
  const generation = eventLogStatsCacheGeneration;
  const file = await open(eventsPath, "r");
  let releaseSlot: (() => void) | undefined;
  let waitedMs = 0;
  try {
    const fileStat = await file.stat();
    const fileId = `${fileStat.dev}:${fileStat.ino}`;
    let startOffset = 0;
    let state: EventLogStatsScannerState | undefined;
    if (
      cached
      && cached.scannedBytes > 0
      && cached.scannedBytes <= upToBytes
      && cached.fileId === fileId
    ) {
      const fingerprint = await readScannedRegionFingerprint(file, cached.scannedBytes);
      if (fingerprint === cached.fingerprint) {
        startOffset = cached.scannedBytes;
        state = cloneEventLogStatsScannerState(cached.state);
      }
    }

    // Folding is sync CPU work, so yield often to keep requests and heartbeats moving.
    const fold = async (from: EventLogStatsScannerState | undefined, start: number) => {
      // Large cold scans queue behind a small concurrency cap; small or resumed ones run freely.
      if (!releaseSlot && upToBytes - start >= EVENT_LOG_STATS_SCAN_GATE_MIN_BYTES) {
        const tWait = Date.now();
        releaseSlot = await acquireEventLogStatsScanSlot();
        waitedMs = Date.now() - tWait;
      }
      const scanner = createEventLogStatsScanner(sessionId, from);
      const { completeEnd, trailing } = await scanJsonlRecords(
        file,
        (record, offset) => scanner.processLine(record, offset),
        { start, end: upToBytes, chunkBytes: EVENT_LOG_STATS_SCAN_CHUNK_BYTES, yieldAfterMs: EVENT_LOG_STATS_SCAN_SLICE_MS },
      );
      // Cache only complete lines: a trailing partial line is completed by a later append.
      const complete = cloneEventLogStatsScannerState(scanner.syncState());
      // Tail transforms read an unterminated last line: count it, but keep it out of the cache.
      if (trailing) scanner.processLine(trailing.record, trailing.offset);
      return { complete, state: scanner.syncState(), scannedBytes: completeEnd };
    };
    let folded = await fold(state, startOffset);
    if (folded.state.cursor.agentTurnsStamped && folded.state.cursor.guessedAgentTurn) {
      // Stamping began after we guessed some turns; full reads treat the log as stamped, so refold.
      startOffset = 0;
      folded = await fold(createEventLogStatsScannerState(true), 0);
    }
    const { scannedBytes } = folded;

    pruneCursorCheckpoints(folded.complete, scannedBytes);
    if (scannedBytes > 0 && eventLogStatsCacheGeneration === generation) {
      const fingerprint = await readScannedRegionFingerprint(file, scannedBytes);
      const current = getCachedEventLogStatsEntry(eventsPath, sessionId);
      // Concurrent readers must never move the cache backwards.
      const isNewer = !current || current.fileId !== fileId || current.scannedBytes <= scannedBytes;
      if (eventLogStatsCacheGeneration === generation && isNewer) {
        setCachedEventLogStatsEntry({
          eventsPath,
          sessionId,
          scannedBytes,
          state: folded.complete,
          fingerprint,
          fileId,
        });
      }
    }

    return { state: folded.state, resumedFrom: startOffset, scannedBytes, waitedMs };
  } finally {
    releaseSlot?.();
    await file.close();
  }
}

async function readMessagesFromDiskFull(
  deps: SessionDiskReaderDeps,
  sessionId: string,
  eventsPath: string,
  startedAt: number,
  opts?: { limit?: number; before?: number },
  metadata: Record<string, unknown> = {},
): Promise<ReadMessagesFromDiskResult> {
  const tRead = Date.now();
  const events: unknown[] = [];
  let malformedEventCount = 0;
  let parseMs = 0;
  // Streamed (histories reach hundreds of MB); events the transcript skips keep only an envelope.
  const addRecord = (record: Buffer): void => {
    const parseStartedAt = performance.now();
    const line = withoutCarriageReturn(record).toString("utf-8");
    if (line.trim()) {
      try {
        events.push(projectTranscriptEvent(JSON.parse(line)));
      } catch {
        malformedEventCount += 1;
      }
    }
    parseMs += performance.now() - parseStartedAt;
  };
  let bytes: number;
  try {
    const file = await open(eventsPath, "r");
    try {
      const { size } = await file.stat();
      const { trailing } = await scanJsonlRecords(file, addRecord, { end: size, chunkBytes: EVENT_LOG_STATS_SCAN_CHUNK_BYTES });
      if (trailing) addRecord(trailing.record);
      bytes = size;
    } finally {
      await file.close();
    }
  } catch {
    return emptyReadResult();
  }
  parseMs = Math.round(parseMs);
  deps.recordSpan("session.readFromDisk.fullRead", Date.now() - tRead, sessionId, {
    bytes,
    ...metadata,
  });

  const tTransform = Date.now();
  const messages = transformEventsToMessages(events, sessionId);
  const transformMs = Date.now() - tTransform;
  const lastVisibleActivityAt = getLastVisibleActivityAt(events, sessionId);
  const coverage = getSessionHistoryCoverage(events);
  const agents = foldTranscriptAgents(events);
  deps.persistLastVisibleActivityAt(sessionId, lastVisibleActivityAt);

  const total = messages.length;
  if (opts?.limit != null && opts.limit > 0) {
    const end = opts.before != null ? opts.before : total;
    const start = Math.max(0, end - opts.limit);
    const sliced = messages.slice(start, end);
    deps.recordSpan("session.readFromDisk", Date.now() - startedAt, sessionId, {
      mode: "full",
      eventCount: events.length,
      malformedEventCount,
      messageCount: sliced.length,
      totalMessages: total,
      parseMs,
      transformMs,
      ...metadata,
    });
    return { messages: sliced, total, hasMore: start > 0, lastVisibleActivityAt, coverage, agents };
  }

  deps.recordSpan("session.readFromDisk", Date.now() - startedAt, sessionId, {
    mode: "full",
    eventCount: events.length,
    malformedEventCount,
    messageCount: messages.length,
    totalMessages: total,
    parseMs,
    transformMs,
    ...metadata,
  });
  return { messages, total, hasMore: false, lastVisibleActivityAt, coverage, agents };
}

/** Every sub-agent a complete event log records, in launch order. */
export function foldTranscriptAgents(events: readonly unknown[]): TranscriptAgent[] {
  const fold = new TranscriptAgentFold();
  for (const event of events) fold.observe(event);
  return fold.list();
}

export function getSessionHistoryCoverage(events: readonly unknown[]): SessionHistoryCoverage {
  let latestEventId: string | undefined;
  let latestTurnId: string | undefined;
  let latestTerminalEventId: string | undefined;
  let fallbackTurnIndex = 0;

  for (const event of events) {
    const eventId = getSdkEventId(event);
    if (eventId) latestEventId = eventId;
    if (event && typeof event === "object") {
      const type = (event as { type?: unknown }).type;
      if (type === "assistant.turn_start") {
        fallbackTurnIndex += 1;
        latestTurnId = getSdkTurnId(event) ?? `turn-${fallbackTurnIndex}`;
      }
      if (typeof type === "string" && isTurnTerminalEvent(event) && eventId) {
        latestTerminalEventId = eventId;
      }
    }
  }

  return {
    ...(latestEventId ? { latestEventId } : {}),
    ...(latestTurnId ? { latestTurnId } : {}),
    ...(latestTerminalEventId ? { latestTerminalEventId } : {}),
  };
}

/** A session as its folder describes it. */
export type DiskSession = {
  sessionId: string;
  startTime?: string;
  summary?: string;
  context?: Record<string, unknown>;
  eventLogSizeBytes?: number;
  lastVisibleActivityAt?: string;
  modifiedTime?: string;
  intentText?: string | null;
};

/** With failOnReadError, undefined means missing; other read errors throw. */
async function readSessionFromDisk(
  deps: SessionDiskReaderDeps,
  sessionStateDir: string,
  sessionId: string,
  failOnReadError = false,
): Promise<DiskSession | undefined> {
  const yamlPath = join(sessionStateDir, sessionId, "workspace.yaml");
  const session: DiskSession = { sessionId };
  let content: string | undefined;
  try {
    content = await readFile(yamlPath, "utf-8");
    const effectiveCwd = await deps.resolveEffectiveSessionCwdFromWorkspaceYaml(sessionId, content);
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith("created_at:")) session.startTime = line.slice(12).trim();
    }
    const name = parseWorkspaceYamlSessionName(content);
    if (name) session.summary = name;
    if (effectiveCwd) session.context = { cwd: effectiveCwd };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const absent = content === undefined && (code === "ENOENT" || code === "ENOTDIR");
    if (failOnReadError && !absent) throw error;
    return undefined;
  }
  try {
    const st = await stat(join(sessionStateDir, sessionId, "events.jsonl"));
    session.eventLogSizeBytes = st.size;
    session.lastVisibleActivityAt = deps.sessionMetaStore?.getMeta(sessionId)?.lastVisibleActivityAt;
    session.modifiedTime = session.lastVisibleActivityAt ?? session.startTime ?? st.mtime.toISOString();
  } catch {
    session.eventLogSizeBytes = 0;
    try {
      const st = await stat(yamlPath);
      session.modifiedTime = session.startTime ?? st.mtime.toISOString();
    } catch {
      // Leave modifiedTime unset if both files disappear during the read.
    }
  }
  session.intentText = deps.eventBusRegistry.getBus(sessionId)?.getIntentText() ?? null;
  return session;
}

export interface SessionsFromDiskOptions {
  includeArchived?: boolean;
  failOnReadError?: boolean;
}

/** Pass failOnReadError when acting on absence, so an unreadable folder isn't taken as gone. */
export async function readSessionsFromDisk(
  deps: SessionDiskReaderDeps,
  sessionIds: readonly string[],
  options: SessionsFromDiskOptions = {},
): Promise<DiskSession[]> {
  const sessionStateDir = join(deps.copilotHome ?? join(homedir(), ".copilot"), "session-state");
  const wanted = options.includeArchived ?? true
    ? sessionIds
    : sessionIds.filter((sessionId) => !deps.sessionMetaStore?.isArchived(sessionId));
  const sessions = await mapWithConcurrency(wanted, SESSION_LIST_READ_CONCURRENCY, (sessionId) =>
    readSessionFromDisk(deps, sessionStateDir, sessionId, options.failOnReadError));
  return sessions.filter((session) => session !== undefined);
}

/** Lists sessions from workspace.yaml; skipped (or archived, by default) folders aren't read. */
export async function listSessionsFromDisk(
  deps: SessionDiskReaderDeps,
  options: { includeArchived?: boolean; skip?: ReadonlySet<string> } = {},
): Promise<DiskSession[]> {
  const t0 = Date.now();
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const sessionStateDir = join(copilotHome, "session-state");
  const includeArchived = options.includeArchived ?? true;

  let entries: Dirent[];
  try {
    entries = await readdir(sessionStateDir, { withFileTypes: true });
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    deps.recordSpan("session.listFromDisk.enumerate", Date.now() - t0, undefined, {
      dirCount: 0,
      includeArchived,
      missing: true,
    });
    deps.recordSpan("session.listFromDisk", Date.now() - t0, undefined, { count: 0, includeArchived });
    return [];
  }
  const skip = options.skip
    ?? new Set(includeArchived ? [] : deps.sessionMetaStore?.listArchivedSessionIds() ?? []);
  const dirs: string[] = [];
  let dirCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    dirCount += 1;
    if (!skip.has(entry.name)) dirs.push(entry.name);
  }
  deps.recordSpan("session.listFromDisk.enumerate", Date.now() - t0, undefined, { dirCount, includeArchived });

  const read = await mapWithConcurrency(dirs, SESSION_LIST_READ_CONCURRENCY, (dirName) =>
    readSessionFromDisk(deps, sessionStateDir, dirName));
  const sessions = read.filter((session) => session !== undefined);
  sessions.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));

  deps.recordSpan("session.listFromDisk", Date.now() - t0, undefined, {
    count: sessions.length,
    includeArchived,
    dirCount,
    skipped: dirCount - dirs.length,
    missingWorkspace: dirs.length - sessions.length,
  });
  return sessions;
}

/** Reads history from events.jsonl; the latest page uses a bounded tail read. */
export async function readMessagesFromDisk(
  deps: SessionDiskReaderDeps,
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<ReadMessagesFromDiskResult> {
  const t0 = Date.now();
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");
  const latestLimit = opts?.before == null && opts?.limit != null && opts.limit > 0
    ? opts.limit
    : undefined;

  if (latestLimit === undefined) {
    return readMessagesFromDiskFull(deps, sessionId, eventsPath, t0, opts);
  }

  const tailPromise = (async () => {
    const tTail = Date.now();
    const tail = await readTailCandidateEvents(eventsPath, sessionId, latestLimit);
    deps.recordSpan("session.readFromDisk.tailRead", Date.now() - tTail, sessionId, {
      bytesRead: tail.bytesRead,
      fileSize: tail.fileSize,
      mtimeMs: tail.mtimeMs,
      startOffset: tail.startOffset,
      readFullFile: tail.readFullFile,
      tailEventCount: tail.events.length,
      malformedCandidateCount: tail.malformedCandidateCount,
    });
    return tail;
  })();
  let tail: TailCandidateEvents;
  try {
    tail = await tailPromise;
  } catch (err) {
    if (isFileNotFoundError(err)) return emptyReadResult();
    throw err;
  }

  const initialFileSize = tail.fileSize;
  const initialMtimeMs = tail.mtimeMs;
  let stats: EventLogStats;
  let derivedTailMessages: TransformedEntry[] | undefined;
  try {
    if (tail.readFullFile && tail.fullContentBuffer) {
      const tStats = Date.now();
      stats = scanEventLogStatsFromBuffer(tail.fullContentBuffer, sessionId, tail.startOffset);
      derivedTailMessages = transformEventsToMessages(tail.events, sessionId, { initialCursor: stats.cursor });
      deps.recordSpan("session.readFromDisk.stats", Date.now() - tStats, sessionId, {
        cacheResult: "derived",
        eventCount: stats.eventCount,
        candidateEventCount: stats.candidateEventCount,
        malformedCandidateCount: stats.malformedCandidateCount,
        totalMessages: stats.totalEntries,
        initialTurnIndex: stats.cursor?.turnIndex,
        hasActiveTurn: stats.cursor?.activeTurnId !== undefined,
      });
    } else {
      const tStats = Date.now();
      const scan = await scanEventLogStats(eventsPath, sessionId, tail.fileSize);
      stats = buildEventLogStats(scan.state, tail.startOffset);
      if (stats.hasUsageRecords && stats.turnStartOffset !== undefined && stats.turnStartOffset < tail.startOffset) {
        // Include the prompt that owns the first partial turn, not just its latest follow-up.
        const minimumBytes = tail.fileSize - Math.max(0, stats.turnStartOffset - 1);
        if (minimumBytes > RECENT_MESSAGES_MAX_TAIL_BYTES) {
          deps.recordSpan("session.readFromDisk.tailFallback", Date.now() - t0, sessionId, {
            reason: "turn-details-boundary",
          });
          return readMessagesFromDiskFull(deps, sessionId, eventsPath, t0, opts, {
            fallbackReason: "turn-details-boundary",
          });
        }
        tail = await readTailCandidateEvents(eventsPath, sessionId, latestLimit, minimumBytes);
        stats = buildEventLogStats(scan.state, tail.startOffset);
      }
      const statsMs = Date.now() - tStats;
      deps.recordSpan("session.readFromDisk.stats", statsMs, sessionId, {
        cacheResult: scan.resumedFrom > 0
          ? (scan.scannedBytes > scan.resumedFrom ? "resumed" : "hit")
          : "miss",
        resumedFromOffset: scan.resumedFrom,
        scannedBytes: scan.scannedBytes - scan.resumedFrom,
        scanQueueWaitMs: scan.waitedMs,
        eventCount: stats.eventCount,
        candidateEventCount: stats.candidateEventCount,
        malformedCandidateCount: stats.malformedCandidateCount,
        totalMessages: stats.totalEntries,
        initialTurnIndex: stats.cursor?.turnIndex,
        hasActiveTurn: stats.cursor?.activeTurnId !== undefined,
      });
    }
  } catch (err) {
    if (isFileNotFoundError(err)) return emptyReadResult();
    throw err;
  }

  let currentFileStat: Awaited<ReturnType<typeof stat>>;
  try {
    currentFileStat = await stat(eventsPath);
  } catch (err) {
    if (isFileNotFoundError(err)) return emptyReadResult();
    throw err;
  }
  if (currentFileStat.size !== initialFileSize || currentFileStat.mtimeMs !== initialMtimeMs) {
    const fallbackReason = currentFileStat.size !== initialFileSize ? "file-size-changed" : "file-mtime-changed";
    deps.recordSpan("session.readFromDisk.tailFallback", Date.now() - t0, sessionId, {
      reason: fallbackReason,
      initialFileSize,
      currentFileSize: currentFileStat.size,
      initialMtimeMs,
      currentMtimeMs: currentFileStat.mtimeMs,
    });
    return readMessagesFromDiskFull(deps, sessionId, eventsPath, t0, opts, {
      fallbackReason,
    });
  }

  if (!stats.cursor) {
    // The saved cursor for this window start was collapsed; guessing would mislabel turns.
    deps.recordSpan("session.readFromDisk.tailFallback", Date.now() - t0, sessionId, {
      reason: "cursor-unavailable",
      startOffset: tail.startOffset,
      fileSize: tail.fileSize,
    });
    return readMessagesFromDiskFull(deps, sessionId, eventsPath, t0, opts, {
      fallbackReason: "cursor-unavailable",
    });
  }

  const tTransform = Date.now();
  const tailMessages = derivedTailMessages
    ?? transformEventsToMessages(tail.events, sessionId, { initialCursor: stats.cursor });
  const transformMs = derivedTailMessages ? 0 : Date.now() - tTransform;

  if (!tail.readFullFile && tailMessages.length < Math.min(latestLimit, stats.totalEntries)) {
    deps.recordSpan("session.readFromDisk.tailFallback", Date.now() - t0, sessionId, {
      reason: "tail-insufficient",
      tailMessageCount: tailMessages.length,
      totalMessages: stats.totalEntries,
      bytesRead: tail.bytesRead,
      fileSize: tail.fileSize,
    });
    return readMessagesFromDiskFull(deps, sessionId, eventsPath, t0, opts, {
      fallbackReason: "tail-insufficient",
      tailMessageCount: tailMessages.length,
    });
  }

  deps.persistLastVisibleActivityAt(sessionId, stats.lastVisibleActivityAt);
  const total = Math.max(stats.totalEntries, tailMessages.length);
  const sliced = tailMessages.slice(Math.max(0, tailMessages.length - latestLimit));
  const start = Math.max(0, total - sliced.length);
  const messages = reindexEntries(sliced, start);

  deps.recordSpan("session.readFromDisk", Date.now() - t0, sessionId, {
    mode: "tail",
    eventCount: stats.eventCount,
    candidateEventCount: stats.candidateEventCount,
    tailEventCount: tail.events.length,
    malformedCandidateCount: stats.malformedCandidateCount + (tail.readFullFile ? 0 : tail.malformedCandidateCount),
    messageCount: messages.length,
    totalMessages: total,
    transformMs,
    bytesRead: tail.bytesRead,
    fileSize: tail.fileSize,
    readFullFile: tail.readFullFile,
  });

  return {
    messages,
    total,
    hasMore: start > 0,
    lastVisibleActivityAt: stats.lastVisibleActivityAt,
    coverage: withLatestEventId(stats.coverage, tail.events),
    agents: stats.agents,
  };
}

/** The fold skips envelope-only events, so take the latest id from the tail, which has them all. */
function withLatestEventId(coverage: SessionHistoryCoverage, tailEvents: readonly unknown[]): SessionHistoryCoverage {
  for (let index = tailEvents.length - 1; index >= 0; index -= 1) {
    const latestEventId = getSdkEventId(tailEvents[index]);
    if (latestEventId) return { ...coverage, latestEventId };
  }
  return coverage;
}

type AroundEventMessage = SearchableMessage & { messageId?: string };

/** The runtime's id for a saved user message, as returned by `session.send`. */
function getSavedUserMessageId(event: unknown): string | undefined {
  const data = (event as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return undefined;
  const messageId = (data as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageId ? messageId : undefined;
}

export async function readMessagesAroundEventFromDisk(
  deps: SessionDiskReaderDeps,
  sessionId: string,
  sourceEventId: string,
  options: { before: number; after: number },
): Promise<ReadMessagesAroundEventResult> {
  const startedAt = Date.now();
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");
  const beforeMessages: AroundEventMessage[] = [];
  const windowMessages: AroundEventMessage[] = [];
  let targetOffset = -1;
  let total = 0;
  let lineNumber = 0;
  let lastVisibleActivityAt: string | undefined;
  for await (const line of readJsonlLines(eventsPath)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Cannot read exact message context because events.jsonl contains malformed JSON at line ${lineNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const projected = projectSearchableMessage(event);
    if (!projected) continue;
    const messageId = projected.role === "user" ? getSavedUserMessageId(event) : undefined;
    const message: AroundEventMessage = messageId ? { ...projected, messageId } : projected;
    const messageOffset = total;
    total += 1;
    if (message.timestamp) lastVisibleActivityAt = message.timestamp;

    if (targetOffset < 0) {
      if (message.sourceEventId === sourceEventId) {
        targetOffset = messageOffset;
        windowMessages.push(...beforeMessages, message);
      } else {
        beforeMessages.push(message);
        if (beforeMessages.length > options.before) beforeMessages.shift();
      }
    } else if (messageOffset <= targetOffset + options.after) {
      windowMessages.push(message);
    }
  }
  if (targetOffset < 0) throw new SessionMessageNotFoundError(sessionId, sourceEventId);

  const startOffset = Math.max(0, targetOffset - beforeMessages.length);
  const endOffset = startOffset + windowMessages.length;
  deps.recordSpan("session.readFromDisk.aroundEvent", Date.now() - startedAt, sessionId, {
    sourceEventId,
    targetOffset,
    startOffset,
    endOffset,
    totalMessages: total,
    mode: "stream",
  });
  return {
    messages: windowMessages.map((message) => ({
      id: message.sourceEventId,
      type: "message",
      sourceEventId: message.sourceEventId,
      role: message.role,
      content: message.content,
      ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      ...(message.messageId ? { messageId: message.messageId } : {}),
    })),
    total,
    targetOffset,
    startOffset,
    endOffset,
    hasMore: startOffset > 0,
    hasNewer: endOffset < total,
    lastVisibleActivityAt,
    coverage: {},
    // A window around one saved message holds messages only, so no step needs its agent named.
    agents: [],
  };
}

/** Memory cap for a tail read. Never use RPC getMessages: a big reply kills the shared stdio. */
export const SESSION_EVENT_LOG_TAIL_MAX_BYTES = resolvePositiveIntegerEnv(
  "BRIDGE_SESSION_EVENT_LOG_TAIL_MAX_BYTES",
  16 * 1024 * 1024,
);
const SESSION_EVENT_LOG_TAIL_INITIAL_BYTES = 256 * 1024;
/** Largest event line the streaming index scan buffers before calling the log malformed. */
const SESSION_EVENT_LOG_MAX_LINE_BYTES = 64 * 1024 * 1024;

function resolvePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function resolveSessionEventsPath(copilotHome: string | undefined, sessionId: string): string {
  return join(copilotHome ?? join(homedir(), ".copilot"), "session-state", sessionId, "events.jsonl");
}

export interface SessionEventsTailOptions {
  /** Stop growing the window once at least this many parsed events are available. */
  maxEvents?: number;
  /** Upper bound on bytes materialized; defaults to {@link SESSION_EVENT_LOG_TAIL_MAX_BYTES}. */
  maxBytes?: number;
  /** Stop growing the window as soon as the parsed events satisfy the predicate. */
  hasEnough?: (events: unknown[]) => boolean;
}

export interface SessionEventsTail {
  /** Parsed events in file order (oldest first). Malformed lines are dropped. */
  events: unknown[];
  fileSize: number;
  /** Byte offset of the first complete line included in `events`. */
  startOffset: number;
  bytesRead: number;
  /** True when the window reached the start of the file, so `events` is the full log. */
  complete: boolean;
  malformedLineCount: number;
}

function parseEventLines(content: string): { events: unknown[]; malformedLineCount: number } {
  const events: unknown[] = [];
  let malformedLineCount = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedLineCount += 1;
    }
  }
  return { events, malformedLineCount };
}

/** Grows a window from the end until enough events or the whole file; never holds over maxBytes. */
export async function readSessionEventsTail(
  eventsPath: string,
  options: SessionEventsTailOptions = {},
): Promise<SessionEventsTail> {
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? SESSION_EVENT_LOG_TAIL_MAX_BYTES, SESSION_EVENT_LOG_TAIL_MAX_BYTES));
  const fileStat = await stat(eventsPath);
  const fileSize = fileStat.size;
  if (fileSize === 0) {
    return { events: [], fileSize, startOffset: 0, bytesRead: 0, complete: true, malformedLineCount: 0 };
  }

  const satisfied = (events: unknown[]): boolean => {
    if (options.maxEvents !== undefined && events.length >= options.maxEvents) return true;
    return options.hasEnough?.(events) === true;
  };

  let bytesToRead = Math.min(fileSize, maxBytes, SESSION_EVENT_LOG_TAIL_INITIAL_BYTES);
  const file = await open(eventsPath, "r");
  try {
    while (true) {
      const position = Math.max(0, fileSize - bytesToRead);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
      let contentBuffer = buffer.subarray(0, bytesRead);
      let startOffset = position;
      if (position > 0) {
        const firstNewline = contentBuffer.indexOf(0x0a);
        if (firstNewline >= 0) {
          contentBuffer = contentBuffer.subarray(firstNewline + 1);
          startOffset = position + firstNewline + 1;
        } else {
          contentBuffer = Buffer.alloc(0);
          startOffset = position + bytesRead;
        }
      }
      const parsed = parseEventLines(contentBuffer.toString("utf-8"));
      const complete = position === 0;
      if (complete || satisfied(parsed.events) || bytesToRead >= Math.min(fileSize, maxBytes)) {
        return {
          events: parsed.events,
          fileSize,
          startOffset,
          bytesRead,
          complete,
          malformedLineCount: parsed.malformedLineCount,
        };
      }
      bytesToRead = Math.min(fileSize, maxBytes, bytesToRead * 2);
    }
  } finally {
    await file.close();
  }
}

export interface SessionEventIndexMatch {
  /** Zero-based position of the event in the log. */
  index: number;
  /** Events after the match; a truncation at this event removes this many plus one. */
  eventsAfter: number;
  totalEvents: number;
  event: unknown;
}

export interface FindSessionEventIndexOptions {
  /** Sees each parsed event before the match, not the match or anything after it. */
  onEventBefore?: (event: unknown, index: number) => void;
  /** Custom matcher; defaults to comparing the persisted event `id`. */
  matches?: (event: unknown) => boolean;
}

/** Streams events.jsonl with bounded memory to find one event; undefined when none matches. */
export async function findSessionEventIndex(
  eventsPath: string,
  eventId: string,
  options: FindSessionEventIndexOptions = {},
): Promise<SessionEventIndexMatch | undefined> {
  const target = eventId.trim();
  const matches = options.matches ?? ((event: unknown) => getSdkEventId(event) === target);
  if (!target && !options.matches) return undefined;

  let match: { index: number; event: unknown } | undefined;
  let totalEvents = 0;
  const processLine = (record: Buffer): void => {
    const line = withoutCarriageReturn(record).toString("utf-8").trim();
    if (!line) return;
    const index = totalEvents;
    totalEvents += 1;
    if (match) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (matches(event)) {
      match = { index, event };
      return;
    }
    options.onEventBefore?.(event, index);
  };

  const file = await open(eventsPath, "r");
  try {
    const { trailing } = await scanJsonlRecords(file, processLine, {
      chunkBytes: EVENT_LOG_STATS_SCAN_CHUNK_BYTES,
      maxRecordBytes: SESSION_EVENT_LOG_MAX_LINE_BYTES,
    });
    if (trailing) processLine(trailing.record);
  } finally {
    await file.close();
  }

  if (!match) return undefined;
  return {
    index: match.index,
    eventsAfter: totalEvents - match.index - 1,
    totalEvents,
    event: match.event,
  };
}

function isPlainUserMessageEvent(event: unknown): event is { data: { content: string } } {
  if (!isRecord(event) || event.type !== "user.message") return false;
  if (isSdkAgentUserMessage(event)) return false;
  const data = eventData(event);
  if (data && "source" in data) return false;
  const content = data?.content;
  return typeof content === "string" && content.trim().length > 0;
}

/** Newest user-authored prompts (oldest first) from a tail window; injected ones are skipped. */
export async function readRecentUserMessages(
  eventsPath: string,
  limit: number,
  options: { maxBytes?: number } = {},
): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.floor(limit));
  let tail: SessionEventsTail;
  try {
    tail = await readSessionEventsTail(eventsPath, {
      maxBytes: options.maxBytes,
      hasEnough: (events) => {
        let count = 0;
        for (const event of events) {
          if (isPlainUserMessageEvent(event)) count += 1;
          if (count >= boundedLimit) return true;
        }
        return false;
      },
    });
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
  const messages: string[] = [];
  for (const event of tail.events) {
    if (isPlainUserMessageEvent(event)) messages.push(String(event.data.content).trim());
  }
  return messages.slice(-boundedLimit);
}
