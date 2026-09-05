import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import {
  createVisibleActivityTracker,
  getLastVisibleActivityAt,
  getVisualArtifactFromToolCompletion,
  isVisibleMessageEvent,
  transformEventsToMessages,
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
  getAssistantTurnInstanceId,
  getSdkEventId,
  getSdkTurnId,
  isSdkAgentUserMessage,
  isSdkSubagentSessionError,
} from "./sdk-event-identity.js";

const RECENT_MESSAGES_INITIAL_TAIL_BYTES = 256 * 1024;
const RECENT_MESSAGES_SINGLE_READ_MAX_BYTES = 1024 * 1024;
const RECENT_MESSAGES_MAX_TAIL_BYTES = 8 * 1024 * 1024;
const EVENT_LOG_STATS_SCAN_CHUNK_BYTES = 256 * 1024;
/**
 * Cached folds are far larger than the plain stats they replaced (they carry turn checkpoints), and
 * only a handful of sessions are ever read concurrently, so this is deliberately small.
 */
const EVENT_LOG_STATS_CACHE_MAX_ENTRIES = 32;
const EVENT_LOG_STATS_CACHE_VERSION = 3;
/** Bytes hashed at the head and at the resume point to detect event-log rewrites. */
const EVENT_LOG_FINGERPRINT_BYTES = 4 * 1024;
/** Backstop bound on retained turn checkpoints when the log has very short turns. */
const EVENT_LOG_TURN_CHECKPOINT_MAX = 2048;
const SESSION_LIST_WORKSPACE_READ_CONCURRENCY = 32;
const SESSION_LIST_EVENT_STAT_CONCURRENCY = 64;

const MESSAGE_RELEVANT_EVENT_MARKERS = [
  "user.message",
  "assistant.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "tool.execution_start",
  "tool.execution_complete",
  "tool.execution_progress",
  "tool.execution_partial_result",
  "subagent.started",
  "session.shutdown",
  "session.idle",
  "session.error",
  "session.task_complete",
  "abort",
];

const TURN_TERMINAL_EVENT_TYPES = TERMINAL_TURN_EVENT_TYPES;
const isTurnTerminalEvent = (event: any): boolean =>
  TURN_TERMINAL_EVENT_TYPES.has(event?.type) && !isSdkSubagentSessionError(event);

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
}

interface WorkspaceSessionRead {
  dirName: string;
  yamlPath: string;
  session: any;
}

interface EventLogStats {
  eventCount: number;
  candidateEventCount: number;
  malformedCandidateCount: number;
  totalEntries: number;
  lastVisibleActivityAt?: string;
  turnState: TailTurnState;
  coverage: SessionHistoryCoverage;
}

interface TailCandidateEvents {
  events: any[];
  bytesRead: number;
  fileSize: number;
  mtimeMs: number;
  startOffset: number;
  readFullFile: boolean;
  malformedCandidateCount: number;
  fullContentBuffer?: Buffer;
}

interface TailTurnState {
  initialTurnIndex: number;
  initialActiveTurnId?: string;
  initialActiveTurnInstanceId?: string;
}

interface TurnStateCheckpoint {
  /** Byte offset of the line that produced this turn state. */
  offset: number;
  turnIndex: number;
  activeTurnId?: string;
  activeTurnInstanceId?: string;
}

/**
 * Serializable fold state for the event-log stats scan. Kept separate from the scanner so a
 * scan can resume from a previously scanned byte offset when the log only grew.
 */
interface EventLogStatsScannerState {
  eventCount: number;
  candidateEventCount: number;
  malformedCandidateCount: number;
  totalEntries: number;
  openVisibleToolCallIds: string[];
  visiblePublishVisualToolCallIds: string[];
  pendingTerminalCompletionEntry: boolean;
  latestEventId?: string;
  latestTurnId?: string;
  latestTerminalEventId?: string;
  turnIndex: number;
  activeTurnId?: string;
  activeTurnInstanceId?: string;
  /** Collapsed state for every checkpoint older than the largest possible tail window. */
  baseTurnCheckpoint: TurnStateCheckpoint;
  turnCheckpoints: TurnStateCheckpoint[];
  activity: VisibleActivityTrackerState;
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

/**
 * Optional durable backing for the fold cache. The in-memory map is the hot path; the
 * persistence layer only has to survive restarts so the first open of a large log after
 * a cutover resumes from the last folded offset instead of rescanning everything.
 */
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
/**
 * Cold scans of large logs are CPU-bound even when sliced; several at once (every session
 * opened right after a restart) would still starve the loop, so they queue behind this cap.
 */
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

function getToolCallId(event: any): string | undefined {
  const toolCallId = event?.data?.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function getToolName(event: any): string {
  const name = event?.data?.toolName ?? event?.data?.name;
  return typeof name === "string" ? name : "unknown";
}

function parseCandidateEventsFromContent(content: string, partialFirstLine: boolean): {
  events: any[];
  malformedCandidateCount: number;
} {
  const normalizedContent = partialFirstLine
    ? (() => {
        const firstNewline = content.indexOf("\n");
        return firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
      })()
    : content;
  const events: any[] = [];
  let malformedCandidateCount = 0;

  for (const rawLine of normalizedContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !lineMayAffectMessageTransform(line)) continue;
    try {
      events.push(JSON.parse(line));
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
    : Math.min(fileSize, RECENT_MESSAGES_INITIAL_TAIL_BYTES);
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
      const parsed = parseCandidateEventsFromContent(contentBuffer.toString("utf-8"), false);
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
      bytesToRead = Math.min(fileSize, bytesToRead * 2);
    }
  } finally {
    await file.close();
  }
}

function createEventLogStatsScannerState(): EventLogStatsScannerState {
  return {
    eventCount: 0,
    candidateEventCount: 0,
    malformedCandidateCount: 0,
    totalEntries: 0,
    openVisibleToolCallIds: [],
    visiblePublishVisualToolCallIds: [],
    pendingTerminalCompletionEntry: false,
    turnIndex: 0,
    baseTurnCheckpoint: { offset: -1, turnIndex: 0 },
    turnCheckpoints: [],
    activity: {
      openVisibleToolCallIds: [],
      quietTurn: false,
      pendingTerminalCompletionActivity: false,
    },
  };
}

function cloneEventLogStatsScannerState(
  state: EventLogStatsScannerState,
): EventLogStatsScannerState {
  return {
    ...state,
    openVisibleToolCallIds: [...state.openVisibleToolCallIds],
    visiblePublishVisualToolCallIds: [...state.visiblePublishVisualToolCallIds],
    baseTurnCheckpoint: { ...state.baseTurnCheckpoint },
    turnCheckpoints: state.turnCheckpoints.map((checkpoint) => ({ ...checkpoint })),
    activity: {
      ...state.activity,
      openVisibleToolCallIds: [...state.activity.openVisibleToolCallIds],
    },
  };
}

/**
 * Folds event-log lines into {@link EventLogStatsScannerState}. The fold is resumable: feeding
 * lines from a byte offset onto a previously captured state is equivalent to scanning the whole
 * file, so an appended log only costs the appended bytes.
 */
function createEventLogStatsScanner(sessionId: string, initialState?: EventLogStatsScannerState) {
  const state = initialState ?? createEventLogStatsScannerState();
  const openVisibleToolCallIds = new Set(state.openVisibleToolCallIds);
  const visiblePublishVisualToolCallIds = new Set(state.visiblePublishVisualToolCallIds);
  const visibleActivityTracker = createVisibleActivityTracker(sessionId, state.activity);

  const recordTurnCheckpoint = (offset: number): void => {
    state.turnCheckpoints.push({
      offset,
      turnIndex: state.turnIndex,
      ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
      ...(state.activeTurnInstanceId ? { activeTurnInstanceId: state.activeTurnInstanceId } : {}),
    });
  };

  const processLine = (lineBuffer: Buffer, lineStartOffset: number): void => {
    const contentEnd = lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d
      ? lineBuffer.length - 1
      : lineBuffer.length;
    const line = lineBuffer.subarray(0, contentEnd).toString("utf-8").trim();
    if (!line) return;
    state.eventCount += 1;
    if (!lineMayAffectMessageTransform(line)) return;

    state.candidateEventCount += 1;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      state.malformedCandidateCount += 1;
      return;
    }

    visibleActivityTracker.observe(event);
    const eventId = getSdkEventId(event);
    if (eventId) state.latestEventId = eventId;
    if (event.type === "assistant.turn_start") {
      state.turnIndex += 1;
      state.latestTurnId = getSdkTurnId(event) ?? `turn-${state.turnIndex}`;
      state.activeTurnId = state.latestTurnId;
      state.activeTurnInstanceId = getAssistantTurnInstanceId(
        event,
        `turn-instance-${state.turnIndex}`,
      );
      recordTurnCheckpoint(lineStartOffset);
    }
    if (isTurnTerminalEvent(event)) {
      if (eventId) state.latestTerminalEventId = eventId;
      state.activeTurnId = undefined;
      state.activeTurnInstanceId = undefined;
      recordTurnCheckpoint(lineStartOffset);
    }
    if (
      event.type === "tool.execution_start"
      && extractTerminalCompletionFromToolCall(getToolName(event), event?.data?.arguments)
    ) {
      state.pendingTerminalCompletionEntry = true;
    }

    if (isVisibleMessageEvent(event, sessionId)) {
      state.totalEntries += 1;
      if (extractTerminalCompletion(event)) state.pendingTerminalCompletionEntry = false;
      if (event.type === "tool.execution_start") {
        const toolCallId = getToolCallId(event);
        if (toolCallId) {
          openVisibleToolCallIds.add(toolCallId);
          if (getToolName(event) === "publish_visual") {
            visiblePublishVisualToolCallIds.add(toolCallId);
          }
        }
      }
      return;
    }

    if (event.type === "tool.execution_complete") {
      const toolCallId = getToolCallId(event);
      if (!toolCallId) return;

      if (openVisibleToolCallIds.has(toolCallId)) {
        openVisibleToolCallIds.delete(toolCallId);
      }

      if (visiblePublishVisualToolCallIds.has(toolCallId)) {
        const visual = getVisualArtifactFromToolCompletion(event, "publish_visual", sessionId);
        if (visual) state.totalEntries += 1;
        visiblePublishVisualToolCallIds.delete(toolCallId);
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
    state.visiblePublishVisualToolCallIds = [...visiblePublishVisualToolCallIds];
    state.activity = visibleActivityTracker.getState();
    return state;
  };

  return { processLine, syncState };
}

/**
 * Collapse checkpoints that can never be selected again into the base checkpoint. Any future
 * `turnStateOffset` is at least `scannedBytes - RECENT_MESSAGES_MAX_TAIL_BYTES`, so older
 * checkpoints only matter through the most recent one below that bound.
 */
function pruneTurnCheckpoints(state: EventLogStatsScannerState, scannedBytes: number): void {
  const minUsefulOffset = scannedBytes - RECENT_MESSAGES_MAX_TAIL_BYTES;
  let collapseCount = 0;
  while (
    collapseCount < state.turnCheckpoints.length
    && state.turnCheckpoints[collapseCount]!.offset < minUsefulOffset
  ) {
    collapseCount += 1;
  }
  // Backstop for logs with very short turns, where the tail window alone bounds nothing useful.
  const overflow = state.turnCheckpoints.length - collapseCount - EVENT_LOG_TURN_CHECKPOINT_MAX;
  if (overflow > 0) collapseCount += overflow;
  if (collapseCount === 0) return;
  state.baseTurnCheckpoint = state.turnCheckpoints[collapseCount - 1]!;
  state.turnCheckpoints = state.turnCheckpoints.slice(collapseCount);
}

function resolveTurnState(
  state: EventLogStatsScannerState,
  turnStateOffset: number,
): TailTurnState {
  let selected = state.baseTurnCheckpoint;
  let low = 0;
  let high = state.turnCheckpoints.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const checkpoint = state.turnCheckpoints[mid]!;
    if (checkpoint.offset < turnStateOffset) {
      selected = checkpoint;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return {
    initialTurnIndex: selected.turnIndex,
    ...(selected.activeTurnId ? { initialActiveTurnId: selected.activeTurnId } : {}),
    ...(selected.activeTurnInstanceId
      ? { initialActiveTurnInstanceId: selected.activeTurnInstanceId }
      : {}),
  };
}

function buildEventLogStats(
  state: EventLogStatsScannerState,
  turnStateOffset: number,
): EventLogStats {
  return {
    eventCount: state.eventCount,
    candidateEventCount: state.candidateEventCount,
    malformedCandidateCount: state.malformedCandidateCount,
    totalEntries: state.totalEntries,
    ...(state.activity.lastVisibleActivityAt
      ? { lastVisibleActivityAt: state.activity.lastVisibleActivityAt }
      : {}),
    turnState: resolveTurnState(state, turnStateOffset),
    coverage: {
      ...(state.latestEventId ? { latestEventId: state.latestEventId } : {}),
      ...(state.latestTurnId ? { latestTurnId: state.latestTurnId } : {}),
      ...(state.latestTerminalEventId ? { latestTerminalEventId: state.latestTerminalEventId } : {}),
    },
  };
}

function scanEventLogStatsFromBuffer(
  contentBuffer: Buffer,
  sessionId: string,
  turnStateOffset: number,
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

  return buildEventLogStats(scanner.syncState(), turnStateOffset);
}

/**
 * Fingerprint the already-scanned region by sampling its head, midpoint, and end. A pure append
 * leaves all three unchanged; an in-place rewrite almost certainly disturbs at least one.
 */
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

/**
 * Scan `eventsPath` up to `upToBytes`, resuming from the cached fold when the log only grew.
 * Head/tail fingerprints over the already-scanned region detect rewrites (compaction, undo,
 * fork) that would otherwise make a resumed fold wrong.
 */
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

    // Large cold scans queue behind a small concurrency cap; small or resumed ones run freely.
    if (upToBytes - startOffset >= EVENT_LOG_STATS_SCAN_GATE_MIN_BYTES) {
      const tWait = Date.now();
      releaseSlot = await acquireEventLogStatsScanSlot();
      waitedMs = Date.now() - tWait;
    }

    const scanner = createEventLogStatsScanner(sessionId, state);
    const chunkBuffer = Buffer.alloc(EVENT_LOG_STATS_SCAN_CHUNK_BYTES);
    let fileOffset = startOffset;
    let leftover = Buffer.alloc(0);
    let leftoverStartOffset = startOffset;
    let scannedBytes = startOffset;
    let sliceStartedAt = performance.now();

    while (fileOffset < upToBytes) {
      const maxRead = Math.min(chunkBuffer.length, upToBytes - fileOffset);
      const { bytesRead } = await file.read(chunkBuffer, 0, maxRead, fileOffset);
      if (bytesRead === 0) break;

      const chunk = chunkBuffer.subarray(0, bytesRead);
      const combined = leftover.length > 0
        ? Buffer.concat([leftover, chunk], leftover.length + bytesRead)
        : chunk;
      const combinedStartOffset = leftover.length > 0 ? leftoverStartOffset : fileOffset;
      let lineStart = 0;

      while (true) {
        const newlineIndex = combined.indexOf(0x0a, lineStart);
        if (newlineIndex < 0) break;
        scanner.processLine(combined.subarray(lineStart, newlineIndex), combinedStartOffset + lineStart);
        lineStart = newlineIndex + 1;
        scannedBytes = combinedStartOffset + lineStart;
      }

      if (lineStart < combined.length) {
        leftover = Buffer.from(combined.subarray(lineStart));
        leftoverStartOffset = combinedStartOffset + lineStart;
      } else {
        leftover = Buffer.alloc(0);
        leftoverStartOffset = fileOffset + bytesRead;
      }
      fileOffset += bytesRead;

      // Folding is synchronous CPU work; hand the loop back regularly so HTTP requests,
      // SSE heartbeats, and other sessions keep moving while a large log is scanned.
      if (performance.now() - sliceStartedAt >= EVENT_LOG_STATS_SCAN_SLICE_MS) {
        await yieldToEventLoop();
        sliceStartedAt = performance.now();
      }
    }

    // Cache only complete lines: a trailing partial line is completed by a later append.
    const persistedState = cloneEventLogStatsScannerState(scanner.syncState());
    pruneTurnCheckpoints(persistedState, scannedBytes);
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
          state: persistedState,
          fingerprint,
          fileId,
        });
      }
    }

    // The tail transform also consumes a final line without a trailing newline, so the returned
    // stats must include it even though it is never folded into the cached state.
    if (leftover.length > 0) {
      scanner.processLine(leftover, leftoverStartOffset);
    }

    return { state: scanner.syncState(), resumedFrom: startOffset, scannedBytes, waitedMs };
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
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf-8");
  } catch {
    return { messages: [], total: 0, hasMore: false, coverage: {} };
  }
  deps.recordSpan("session.readFromDisk.fullRead", Date.now() - tRead, sessionId, {
    bytes: Buffer.byteLength(raw),
    ...metadata,
  });

  const tParse = Date.now();
  const events: any[] = [];
  let malformedEventCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedEventCount += 1;
    }
  }
  const parseMs = Date.now() - tParse;

  const tTransform = Date.now();
  const messages = transformEventsToMessages(events, sessionId);
  const transformMs = Date.now() - tTransform;
  const lastVisibleActivityAt = getLastVisibleActivityAt(events, sessionId);
  const coverage = getSessionHistoryCoverage(events);
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
    return { messages: sliced, total, hasMore: start > 0, lastVisibleActivityAt, coverage };
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
  return { messages, total, hasMore: false, lastVisibleActivityAt, coverage };
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

/**
 * Fast session listing - reads workspace.yaml from disk instead of SDK RPC.
 * Async to avoid blocking the event loop during filesystem I/O.
 */
export async function listSessionsFromDisk(
  deps: SessionDiskReaderDeps,
  options: { includeArchived?: boolean } = {},
): Promise<any[]> {
  const t0 = Date.now();
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const sessionStateDir = join(copilotHome, "session-state");
  const includeArchived = options.includeArchived ?? true;

  const tEnumerate = Date.now();
  let entries: any[];
  try {
    entries = await readdir(sessionStateDir, { withFileTypes: true });
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    deps.recordSpan("session.listFromDisk.enumerate", Date.now() - tEnumerate, undefined, {
      dirCount: 0,
      includeArchived,
      missing: true,
    });
    deps.recordSpan("session.listFromDisk", Date.now() - t0, undefined, { count: 0, includeArchived });
    return [];
  }
  const dirs = entries
    .filter((d: any) => d.isDirectory())
    .map((d: any) => d.name);
  deps.recordSpan("session.listFromDisk.enumerate", Date.now() - tEnumerate, undefined, {
    dirCount: dirs.length,
    includeArchived,
  });

  const meta = deps.sessionMetaStore?.listMeta() ?? {};
  const tWorkspace = Date.now();
  let skippedArchived = 0;
  let missingWorkspace = 0;
  const workspaceReads = await mapWithConcurrency(dirs, SESSION_LIST_WORKSPACE_READ_CONCURRENCY, async (dirName): Promise<WorkspaceSessionRead | null> => {
    const sessionMeta = meta[dirName];
    if (!includeArchived && sessionMeta?.archived) {
      skippedArchived += 1;
      return null;
    }

    const yamlPath = join(sessionStateDir, dirName, "workspace.yaml");
    try {
      const content = await readFile(yamlPath, "utf-8");
      const session: any = { sessionId: dirName };
      const effectiveCwd = await deps.resolveEffectiveSessionCwdFromWorkspaceYaml(dirName, content);

      for (const line of content.split(/\r?\n/)) {
        if (line.startsWith("created_at:")) session.startTime = line.slice(12).trim();
      }
      const name = parseWorkspaceYamlSessionName(content);
      if (name) session.summary = name;
      if (effectiveCwd) session.context = { cwd: effectiveCwd };
      return { dirName, yamlPath, session };
    } catch {
      missingWorkspace += 1;
      return null;
    }
  });
  const readableWorkspaceSessions = workspaceReads.filter((s): s is WorkspaceSessionRead => s !== null);
  deps.recordSpan("session.listFromDisk.workspace", Date.now() - tWorkspace, undefined, {
    dirCount: dirs.length,
    readCount: readableWorkspaceSessions.length,
    skippedArchived,
    missingWorkspace,
    includeArchived,
    concurrency: SESSION_LIST_WORKSPACE_READ_CONCURRENCY,
  });

  const tEventsStat = Date.now();
  const sessions = await mapWithConcurrency(readableWorkspaceSessions, SESSION_LIST_EVENT_STAT_CONCURRENCY, async ({ dirName, yamlPath, session }) => {
    const sessionMeta = meta[dirName];
    const eventsPath = join(sessionStateDir, dirName, "events.jsonl");
    try {
      const st = await stat(eventsPath);
      session.eventLogSizeBytes = st.size;
      session.lastVisibleActivityAt = sessionMeta?.lastVisibleActivityAt;
      session.modifiedTime = session.lastVisibleActivityAt ?? session.startTime ?? st.mtime.toISOString();
    } catch {
      session.eventLogSizeBytes = 0;
      try {
        const st = await stat(yamlPath);
        session.modifiedTime = session.startTime ?? st.mtime.toISOString();
      } catch {
        // Leave modifiedTime unset if both files disappear during the scan.
      }
    }
    session.intentText = deps.eventBusRegistry.getBus(dirName)?.getIntentText() ?? null;
    return session;
  });
  deps.recordSpan("session.listFromDisk.eventsStat", Date.now() - tEventsStat, undefined, {
    count: sessions.length,
    includeArchived,
    concurrency: SESSION_LIST_EVENT_STAT_CONCURRENCY,
  });

  const tSort = Date.now();
  sessions.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
  deps.recordSpan("session.listFromDisk.sort", Date.now() - tSort, undefined, {
    count: sessions.length,
    includeArchived,
  });

  deps.recordSpan("session.listFromDisk", Date.now() - t0, undefined, { count: sessions.length, includeArchived });
  return sessions;
}

/**
 * Read messages directly from events.jsonl on disk - no SDK resume needed.
 * The common latest-page path uses a bounded tail read plus lightweight stats
 * scan so giant histories do not need full event transformation before slicing.
 */
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
    if (isFileNotFoundError(err)) return { messages: [], total: 0, hasMore: false, coverage: {} };
    throw err;
  }

  let stats: EventLogStats;
  let derivedTailMessages: TransformedEntry[] | undefined;
  try {
    if (tail.readFullFile && tail.fullContentBuffer) {
      const tStats = Date.now();
      stats = scanEventLogStatsFromBuffer(tail.fullContentBuffer, sessionId, tail.startOffset);
      derivedTailMessages = transformEventsToMessages(tail.events, sessionId, stats.turnState);
      deps.recordSpan("session.readFromDisk.stats", Date.now() - tStats, sessionId, {
        cacheResult: "derived",
        eventCount: stats.eventCount,
        candidateEventCount: stats.candidateEventCount,
        malformedCandidateCount: stats.malformedCandidateCount,
        totalMessages: stats.totalEntries,
        initialTurnIndex: stats.turnState.initialTurnIndex,
        hasActiveTurn: stats.turnState.initialActiveTurnId !== undefined,
      });
    } else {
      const tStats = Date.now();
      const scan = await scanEventLogStats(eventsPath, sessionId, tail.fileSize);
      stats = buildEventLogStats(scan.state, tail.startOffset);
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
        initialTurnIndex: stats.turnState.initialTurnIndex,
        hasActiveTurn: stats.turnState.initialActiveTurnId !== undefined,
      });
    }
  } catch (err) {
    if (isFileNotFoundError(err)) return { messages: [], total: 0, hasMore: false, coverage: {} };
    throw err;
  }

  let currentFileStat: Awaited<ReturnType<typeof stat>>;
  try {
    currentFileStat = await stat(eventsPath);
  } catch (err) {
    if (isFileNotFoundError(err)) return { messages: [], total: 0, hasMore: false, coverage: {} };
    throw err;
  }
  if (currentFileStat.size !== tail.fileSize || currentFileStat.mtimeMs !== tail.mtimeMs) {
    const fallbackReason = currentFileStat.size !== tail.fileSize ? "file-size-changed" : "file-mtime-changed";
    deps.recordSpan("session.readFromDisk.tailFallback", Date.now() - t0, sessionId, {
      reason: fallbackReason,
      initialFileSize: tail.fileSize,
      currentFileSize: currentFileStat.size,
      initialMtimeMs: tail.mtimeMs,
      currentMtimeMs: currentFileStat.mtimeMs,
    });
    return readMessagesFromDiskFull(deps, sessionId, eventsPath, t0, opts, {
      fallbackReason,
    });
  }

  const tTransform = Date.now();
  const tailMessages = derivedTailMessages ?? transformEventsToMessages(tail.events, sessionId, stats.turnState);
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
    coverage: stats.coverage,
  };
}

// ── Disk-only event log reads ──────────────────────────────────────────────
//
// The Bridge never asks the agent backend for a session's full event history
// over RPC: a single `session.getMessages` response for a large transcript
// (tens of MB) tears down the one stdio JSON-RPC connection shared by every
// live session. events.jsonl is the persisted source of truth, so every
// history read below streams from disk with bounded memory instead.

/** Hard cap on bytes a bounded tail read may hold in memory at once. */
export const SESSION_EVENT_LOG_TAIL_MAX_BYTES = resolvePositiveIntegerEnv(
  "BRIDGE_SESSION_EVENT_LOG_TAIL_MAX_BYTES",
  16 * 1024 * 1024,
);
const SESSION_EVENT_LOG_TAIL_INITIAL_BYTES = 256 * 1024;
/** Largest single event line the streaming index scan will buffer before treating the log as malformed. */
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

/**
 * Read the newest events from a session's events.jsonl, growing the window
 * from the end of the file until `maxEvents`/`hasEnough` is satisfied, the
 * whole file is covered, or the byte cap is hit. Never loads more than
 * `maxBytes` into memory.
 */
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
  /** Number of events persisted after the match (the count a truncation at this event removes, plus one for itself). */
  eventsAfter: number;
  totalEvents: number;
  event: unknown;
}

export interface FindSessionEventIndexOptions {
  /** Observe every parsed event that precedes the match (not invoked for the match itself or anything after). */
  onEventBefore?: (event: unknown, index: number) => void;
  /** Custom matcher; defaults to comparing the persisted event `id`. */
  matches?: (event: unknown) => boolean;
}

/**
 * Locate one event in events.jsonl by streaming the file line by line with
 * bounded memory. Returns `undefined` when no event matches.
 */
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
  const file = await open(eventsPath, "r");
  try {
    const chunk = Buffer.alloc(EVENT_LOG_STATS_SCAN_CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let position = 0;

    const processLine = (lineBuffer: Buffer): void => {
      const contentEnd = lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d
        ? lineBuffer.length - 1
        : lineBuffer.length;
      const line = lineBuffer.subarray(0, contentEnd).toString("utf-8").trim();
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

    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      for (let i = 0; i < bytesRead; i += 1) {
        if (chunk[i] !== 0x0a) continue;
        const segment = chunk.subarray(start, i);
        if (pendingBytes > 0) {
          processLine(Buffer.concat([...pending, segment], pendingBytes + segment.length));
          pending = [];
          pendingBytes = 0;
        } else {
          processLine(segment);
        }
        start = i + 1;
      }
      if (start < bytesRead) {
        const rest = Buffer.from(chunk.subarray(start, bytesRead));
        pending.push(rest);
        pendingBytes += rest.length;
        if (pendingBytes > SESSION_EVENT_LOG_MAX_LINE_BYTES) {
          throw new Error(`events.jsonl line exceeds ${SESSION_EVENT_LOG_MAX_LINE_BYTES} bytes at offset ${position - pendingBytes}`);
        }
      }
    }
    if (pendingBytes > 0) {
      processLine(Buffer.concat(pending, pendingBytes));
    }
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

function isPlainUserMessageEvent(event: any): boolean {
  if (event?.type !== "user.message") return false;
  if (isSdkAgentUserMessage(event)) return false;
  const data = event.data;
  if (data && typeof data === "object" && "source" in data) return false;
  const content = data?.content;
  return typeof content === "string" && content.trim().length > 0;
}

/**
 * Newest `limit` user-authored prompts from events.jsonl (oldest first),
 * read from a bounded tail window. Agent-injected and skill/system-sourced
 * user messages are excluded.
 */
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
    if (isPlainUserMessageEvent(event)) messages.push(String((event as any).data.content).trim());
  }
  return messages.slice(-boundedLimit);
}
