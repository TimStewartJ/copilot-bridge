import { homedir } from "node:os";
import { join } from "node:path";
import { open, readdir, readFile, stat } from "node:fs/promises";
import {
  createVisibleActivityTracker,
  getLastVisibleActivityAt,
  getVisualArtifactFromToolCompletion,
  isVisibleTransformedEntryEvent,
  transformEventsToMessages,
  type TransformedEntry,
} from "./event-transform.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionMetaStore } from "./session-meta-store.js";

const RECENT_MESSAGES_INITIAL_TAIL_BYTES = 256 * 1024;
const RECENT_MESSAGES_MAX_TAIL_BYTES = 8 * 1024 * 1024;
const EVENT_LOG_STATS_SCAN_CHUNK_BYTES = 256 * 1024;

const MESSAGE_RELEVANT_EVENT_MARKERS = [
  "user.message",
  "assistant.message",
  "assistant.turn_start",
  "tool.execution_start",
  "tool.execution_complete",
  "tool.execution_progress",
  "tool.execution_partial_result",
  "subagent.started",
  "session.shutdown",
  "session.idle",
  "session.error",
  "abort",
];

const TURN_TERMINAL_EVENT_TYPES = new Set([
  "session.shutdown",
  "abort",
  "session.idle",
  "session.error",
]);

export interface SessionDiskReaderDeps {
  copilotHome?: string;
  sessionMetaStore?: SessionMetaStore;
  eventBusRegistry: Pick<EventBusRegistry, "getBus">;
  parseWorkspaceSummary(content: string): string | undefined;
  resolveEffectiveSessionCwdFromWorkspaceYaml(sessionId: string, content: string): string | undefined;
  recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void;
  persistLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt?: string): void;
}

export interface ReadMessagesFromDiskResult {
  messages: TransformedEntry[];
  total: number;
  hasMore: boolean;
  lastVisibleActivityAt?: string;
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
}

interface TailCandidateEvents {
  events: any[];
  bytesRead: number;
  fileSize: number;
  startOffset: number;
  readFullFile: boolean;
  malformedCandidateCount: number;
}

interface TailTurnState {
  initialTurnIndex: number;
  initialActiveTurnId?: string;
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
      startOffset: 0,
      readFullFile: true,
      malformedCandidateCount: 0,
    };
  }

  let bytesToRead = Math.min(fileSize, RECENT_MESSAGES_INITIAL_TAIL_BYTES);
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
        startOffset,
        readFullFile: position === 0,
        malformedCandidateCount: parsed.malformedCandidateCount,
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

async function scanEventLogStats(
  eventsPath: string,
  sessionId: string,
  turnStateOffset: number,
): Promise<EventLogStats> {
  const openVisibleToolCallIds = new Set<string>();
  const visiblePublishVisualToolCallIds = new Set<string>();
  const visibleActivityTracker = createVisibleActivityTracker(sessionId);
  let eventCount = 0;
  let candidateEventCount = 0;
  let malformedCandidateCount = 0;
  let totalEntries = 0;
  let initialTurnIndex = 0;
  let initialActiveTurnId: string | undefined;

  const processLine = (lineBuffer: Buffer, lineStartOffset: number) => {
    const contentEnd = lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d
      ? lineBuffer.length - 1
      : lineBuffer.length;
    const line = lineBuffer.subarray(0, contentEnd).toString("utf-8").trim();
    const lineStartsBeforeTail = lineStartOffset < turnStateOffset;
    if (!line) return;
    eventCount += 1;
    if (!lineMayAffectMessageTransform(line)) return;

    candidateEventCount += 1;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      malformedCandidateCount += 1;
      return;
    }

    visibleActivityTracker.observe(event);

    if (lineStartsBeforeTail) {
      if (event.type === "assistant.turn_start") {
        initialTurnIndex += 1;
        initialActiveTurnId = `turn-${initialTurnIndex}`;
      } else if (TURN_TERMINAL_EVENT_TYPES.has(event.type)) {
        initialActiveTurnId = undefined;
      }
    }

    if (isVisibleTransformedEntryEvent(event, sessionId)) {
      totalEntries += 1;
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
        if (visual) totalEntries += 1;
        visiblePublishVisualToolCallIds.delete(toolCallId);
      }
      return;
    }

    if (TURN_TERMINAL_EVENT_TYPES.has(event.type) && openVisibleToolCallIds.size > 0) {
      openVisibleToolCallIds.clear();
    }
  };

  const file = await open(eventsPath, "r");
  try {
    const chunkBuffer = Buffer.alloc(EVENT_LOG_STATS_SCAN_CHUNK_BYTES);
    let fileOffset = 0;
    let leftover = Buffer.alloc(0);
    let leftoverStartOffset = 0;

    while (true) {
      const { bytesRead } = await file.read(chunkBuffer, 0, chunkBuffer.length, fileOffset);
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
        processLine(combined.subarray(lineStart, newlineIndex), combinedStartOffset + lineStart);
        lineStart = newlineIndex + 1;
      }

      if (lineStart < combined.length) {
        leftover = Buffer.from(combined.subarray(lineStart));
        leftoverStartOffset = combinedStartOffset + lineStart;
      } else {
        leftover = Buffer.alloc(0);
        leftoverStartOffset = fileOffset + bytesRead;
      }
      fileOffset += bytesRead;
    }

    if (leftover.length > 0) {
      processLine(leftover, leftoverStartOffset);
    }
  } finally {
    await file.close();
  }

  return {
    eventCount,
    candidateEventCount,
    malformedCandidateCount,
    totalEntries,
    lastVisibleActivityAt: visibleActivityTracker.getLastVisibleActivityAt(),
    turnState: {
      initialTurnIndex,
      ...(initialActiveTurnId ? { initialActiveTurnId } : {}),
    },
  };
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
    return { messages: [], total: 0, hasMore: false };
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
    return { messages: sliced, total, hasMore: start > 0, lastVisibleActivityAt };
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
  return { messages, total, hasMore: false, lastVisibleActivityAt };
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
  } catch {
    deps.recordSpan("session.listFromDisk.enumerate", Date.now() - tEnumerate, undefined, {
      dirCount: 0,
      includeArchived,
      missing: true,
    });
    deps.recordSpan("session.listFromDisk", Date.now() - t0, undefined, { count: 0, includeArchived });
    return [];
  }
  const dirs = entries.filter((d: any) => d.isDirectory()).map((d: any) => d.name);
  deps.recordSpan("session.listFromDisk.enumerate", Date.now() - tEnumerate, undefined, {
    dirCount: dirs.length,
    includeArchived,
  });

  const meta = deps.sessionMetaStore?.listMeta() ?? {};
  const tWorkspace = Date.now();
  let skippedArchived = 0;
  let missingWorkspace = 0;
  const workspaceReads = await Promise.all(dirs.map(async (dirName): Promise<WorkspaceSessionRead | null> => {
    const sessionMeta = meta[dirName];
    if (!includeArchived && sessionMeta?.archived) {
      skippedArchived += 1;
      return null;
    }

    const yamlPath = join(sessionStateDir, dirName, "workspace.yaml");
    try {
      const content = await readFile(yamlPath, "utf-8");
      const session: any = { sessionId: dirName };
      const summary = deps.parseWorkspaceSummary(content);
      if (summary) session.summary = summary;
      const effectiveCwd = deps.resolveEffectiveSessionCwdFromWorkspaceYaml(dirName, content);

      for (const line of content.split(/\r?\n/)) {
        if (line.startsWith("created_at:")) session.startTime = line.slice(12).trim();
      }
      if (effectiveCwd) session.context = { cwd: effectiveCwd };
      return { dirName, yamlPath, session };
    } catch {
      missingWorkspace += 1;
      return null;
    }
  }));
  const readableWorkspaceSessions = workspaceReads.filter((s): s is WorkspaceSessionRead => s !== null);
  deps.recordSpan("session.listFromDisk.workspace", Date.now() - tWorkspace, undefined, {
    dirCount: dirs.length,
    readCount: readableWorkspaceSessions.length,
    skippedArchived,
    missingWorkspace,
    includeArchived,
  });

  const tEventsStat = Date.now();
  const sessions = await Promise.all(readableWorkspaceSessions.map(async ({ dirName, yamlPath, session }) => {
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
  }));
  deps.recordSpan("session.listFromDisk.eventsStat", Date.now() - tEventsStat, undefined, {
    count: sessions.length,
    includeArchived,
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

  try {
    await stat(eventsPath);
  } catch {
    return { messages: [], total: 0, hasMore: false };
  }

  const tailPromise = (async () => {
    const tTail = Date.now();
    const tail = await readTailCandidateEvents(eventsPath, sessionId, latestLimit);
    deps.recordSpan("session.readFromDisk.tailRead", Date.now() - tTail, sessionId, {
      bytesRead: tail.bytesRead,
      fileSize: tail.fileSize,
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
    if (isFileNotFoundError(err)) return { messages: [], total: 0, hasMore: false };
    throw err;
  }

  let stats: EventLogStats;
  try {
    const tStats = Date.now();
    stats = await scanEventLogStats(eventsPath, sessionId, tail.startOffset);
    deps.recordSpan("session.readFromDisk.stats", Date.now() - tStats, sessionId, {
      eventCount: stats.eventCount,
      candidateEventCount: stats.candidateEventCount,
      malformedCandidateCount: stats.malformedCandidateCount,
      totalMessages: stats.totalEntries,
      initialTurnIndex: stats.turnState.initialTurnIndex,
      hasActiveTurn: stats.turnState.initialActiveTurnId !== undefined,
    });
  } catch (err) {
    if (isFileNotFoundError(err)) return { messages: [], total: 0, hasMore: false };
    throw err;
  }

  let currentFileStat: Awaited<ReturnType<typeof stat>>;
  try {
    currentFileStat = await stat(eventsPath);
  } catch (err) {
    if (isFileNotFoundError(err)) return { messages: [], total: 0, hasMore: false };
    throw err;
  }
  if (currentFileStat.size !== tail.fileSize) {
    deps.recordSpan("session.readFromDisk.tailFallback", Date.now() - t0, sessionId, {
      reason: "file-size-changed",
      initialFileSize: tail.fileSize,
      currentFileSize: currentFileStat.size,
    });
    return readMessagesFromDiskFull(deps, sessionId, eventsPath, t0, opts, {
      fallbackReason: "file-size-changed",
    });
  }

  const tTransform = Date.now();
  const tailMessages = transformEventsToMessages(tail.events, sessionId, stats.turnState);
  const transformMs = Date.now() - tTransform;

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
    malformedCandidateCount: stats.malformedCandidateCount + tail.malformedCandidateCount,
    messageCount: messages.length,
    totalMessages: total,
    transformMs,
    bytesRead: tail.bytesRead,
    fileSize: tail.fileSize,
    readFullFile: tail.readFullFile,
  });

  return { messages, total, hasMore: start > 0, lastVisibleActivityAt: stats.lastVisibleActivityAt };
}
