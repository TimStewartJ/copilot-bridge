// A durable record of each agent-backend loss, kept under the data directory.
//
// Telemetry spans are pruned after a week and the runtime's own log holds only its last few
// minutes, so the evidence for a loss is usually gone before anyone looks. A record keeps what
// the Bridge knew when it gave the backend up, and the runtime's account of its final minutes.

import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonlLines } from "./jsonl-lines.js";
import { pruneRetainedLogFiles } from "./log-retention.js";

export const BACKEND_LOSS_DIR_NAME = "backend-losses";
const MAX_RECORDS = 200;

const RUNTIME_LOG_WINDOW_MS = 3 * 60_000;
/** The runtime keeps writing until the Bridge has killed it. */
const RUNTIME_LOG_AFTER_LOSS_MS = 30_000;
/** The runtime keeps five 10 MB files; the limit only guards against a log that has stopped rotating. */
const RUNTIME_LOG_MAX_BYTES = 64 * 1024 * 1024;
const RUNTIME_LOG_MAX_LINES = 400;
const RUNTIME_LOG_MAX_LINE_CHARS = 300;
/** The runtime starts logging while the SDK is still connecting, before the Bridge counts the backend as started. */
const RUNTIME_LOG_START_SLACK_MS = 2 * 60_000;

const PROCESS_LOG_NAME = /^process-(\d+)-(\d+)(?:\.\d+)?\.log$/;
const LINE_HEAD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) \[(DEBUG|INFO|WARNING|WARN|ERROR)\] ?/;

/** Model requests and responses, and the HTML tokenizer's trace of fetched pages. */
const PAYLOAD_TAGS = ["[rust:model_wire]", "[rust:log]"];

/**
 * Session and server lifecycle lines, which carry ids, step names and durations only. Everything
 * else at INFO or DEBUG is dropped: those levels also log request bodies and tool descriptions.
 */
const LIFECYCLE_LINES: readonly RegExp[] = [
  /^Created session: /,
  /^Resumed session: /,
  /^Workspace initialized: /,
  /^Cleaning up session /,
  /^Cleaned up event forwarding for session /,
  /^Closing session /,
  /^\[close\] /,
  /^\[shutdown\] /,
  /^Preparing runtime for graceful shutdown/,
  /^Starting graceful shutdown/,
  /^Destroying \d+ active sessions/,
  /^CLI server prepared for shutdown/,
  /^Direct session host channel read failed/,
  /^\[rust:rmcp::service\] (serve finished|input stream terminated|task cancelled)/,
  /^\[rust:copilot_runtime::session::services\] session services shutdown stage /,
];

const EVENT_DELIVERY = "[rust:copilot_runtime::session::pending_request_flow] Detached host delivery started ";
const EVENT_DELIVERY_SESSION = /"delivery_session_id":"([0-9a-f-]{36})"/;
const EVENT_DELIVERY_TYPE = /"event_type":"([A-Za-z0-9_.]+)"/;

export type BackendLossPing = {
  /**
   * "skipped": the backend had already reported its channel lost, so nothing was sent.
   * "failed" or "timeout" is conclusive only if it took less than `runtimeKilledAfterMs`.
   */
  outcome: "responsive" | "timeout" | "failed" | "skipped" | "unsupported";
  elapsedMs: number;
};

export type BackendLossRecovery = {
  outcome: "recovered" | "failed";
  durationMs: number;
  error?: string;
};

export type RuntimeLogExcerpt =
  | { status: "unavailable"; reason: string }
  | {
      status: "read";
      /** How the lost runtime's log was told apart from the others in the folder. */
      matchedBy: "pid" | "start-time";
      files: string[];
      windowSeconds: number;
      /** False when the files on disk no longer reach back to the start of the window. */
      reachesWindowStart: boolean;
      /** The last line the runtime wrote, of any kind. */
      lastLineAt: string | null;
      /** Events the runtime handed to the Bridge inside the window, per session. */
      eventDeliveries: Array<{ sessionId: string; count: number; lastAt: string; lastEventType: string | null }>;
      /** Lifecycle, warning and error lines inside the window, oldest first, each cut to a fixed length. */
      lines: string[];
      earlierLinesOmitted: number;
    };

export interface BackendLossRecord {
  version: 1;
  /** When the Bridge gave the backend up. */
  at: string;
  reason: string;
  detail?: string;
  /**
   * "bridge": the Bridge replaced a runtime that had not reported a failure, because a session
   * release or resume never finished. "runtime": its channel failed or it stopped answering.
   */
  origin: "bridge" | "runtime";
  summary: string;
  trigger: {
    sessionId: string;
    operation: "release" | "resume";
    startedAt: string;
    waitedMs: number;
    retirementReason?: string;
  } | null;
  server: { pid: number; startedAt: string; uptimeMs: number };
  backend: {
    generation: number;
    startedAt: string | null;
    uptimeMs: number | null;
    connection: string | null;
    pid: number | null;
    runtimePids: number[];
  };
  /** The host's last wake from sleep as this server saw it; nulls when it has not slept since the server started. */
  host: { lastResumeAt: string | null; msSinceResume: number | null; sleptMs: number | null };
  /** The newest event any session's runtime handle delivered to the Bridge. */
  lastRuntimeEvent: { at: string; msBeforeLoss: number; sessionId: string; type: string } | null;
  interruptedRuns: Array<{
    sessionId: string;
    promptAccepted: boolean;
    attentionMode: "normal" | "quiet";
    /** "queued", or why the Bridge will not continue the run on its own. */
    autoResume: string;
    idleMs: number | null;
  }>;
  cachedSessions: Array<{ sessionId: string; idleMs: number | null }>;
  pendingReleases: Array<{ sessionId: string; phase: string; waitedMs: number }>;
  /** The four fields below are filled in once the first recovery attempt settles. */
  ping: BackendLossPing | null;
  /** From the loss until the Bridge's first kill of the runtime's processes finished. */
  runtimeKilledAfterMs: number | null;
  recovery: BackendLossRecovery | null;
  runtimeLog: RuntimeLogExcerpt | null;
}

export interface RuntimeLogExcerptOptions {
  logsDir: string;
  /** Process ids of the lost runtime, when the backend captured them. */
  pids: readonly number[];
  /** When the lost backend finished starting; picks the log when no pid matches. */
  backendStartedAtMs: number | null;
  lossAtMs: number;
}

export function keepRuntimeLogLine(level: string, body: string): boolean {
  if (PAYLOAD_TAGS.some((tag) => body.startsWith(tag))) return false;
  if (level === "WARNING" || level === "WARN" || level === "ERROR") return true;
  return LIFECYCLE_LINES.some((pattern) => pattern.test(body));
}

function errorText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ?? (error instanceof Error ? error.message : String(error));
}

type ProcessLog = { startedAtMs: number; pid: number; names: string[] };

function chooseProcessLog(
  names: readonly string[],
  options: RuntimeLogExcerptOptions,
): { log: ProcessLog; matchedBy: "pid" | "start-time" } | null {
  const logs = new Map<string, ProcessLog>();
  for (const name of names) {
    const match = PROCESS_LOG_NAME.exec(name);
    if (!match) continue;
    const key = `${match[1]}-${match[2]}`;
    const log = logs.get(key) ?? { startedAtMs: Number(match[1]), pid: Number(match[2]), names: [] };
    log.names.push(name);
    logs.set(key, log);
  }
  const newest = (candidates: ProcessLog[]) =>
    candidates.reduce<ProcessLog | null>((best, log) => (!best || log.startedAtMs > best.startedAtMs ? log : best), null);

  // A pid can be reused within the retained logs; the lost runtime is the newest process that had it.
  const byPid = newest([...logs.values()].filter((log) =>
    options.pids.includes(log.pid) && log.startedAtMs <= options.lossAtMs));
  if (byPid) return { log: byPid, matchedBy: "pid" };

  const startedAtMs = options.backendStartedAtMs;
  if (startedAtMs === null) return null;
  const byStart = newest([...logs.values()].filter((log) =>
    log.startedAtMs <= startedAtMs && log.startedAtMs >= startedAtMs - RUNTIME_LOG_START_SLACK_MS));
  return byStart ? { log: byStart, matchedBy: "start-time" } : null;
}

/**
 * Reads what the lost runtime logged in its final minutes. Model traffic and tool payloads are
 * never copied: lifecycle lines are matched by shape, and warnings and errors are cut short.
 */
export async function readRuntimeLogExcerpt(options: RuntimeLogExcerptOptions): Promise<RuntimeLogExcerpt> {
  let names: string[];
  try {
    names = await readdir(options.logsDir);
  } catch (error) {
    return { status: "unavailable", reason: errorText(error) };
  }
  const chosen = chooseProcessLog(names, options);
  if (!chosen) return { status: "unavailable", reason: "no runtime log matches the lost backend" };

  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of chosen.log.names) {
    try {
      const { size, mtimeMs } = await stat(join(options.logsDir, name));
      files.push({ name, size, mtimeMs });
    } catch { /* rotated away since the listing */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const windowStartMs = options.lossAtMs - RUNTIME_LOG_WINDOW_MS;
  const windowEndMs = options.lossAtMs + RUNTIME_LOG_AFTER_LOSS_MS;
  const deliveries = new Map<string, { count: number; lastAtMs: number; lastEventType: string | null }>();
  const keptNewestFirst: string[][] = [];
  const read: string[] = [];
  let lastLineAtMs: number | null = null;
  let oldestLineAtMs: number | null = null;
  let bytes = 0;

  for (const file of files) {
    if (bytes + file.size > RUNTIME_LOG_MAX_BYTES) break;
    bytes += file.size;
    read.push(file.name);
    const kept: string[] = [];
    let firstAtMs: number | null = null;
    try {
      for await (const line of readJsonlLines(join(options.logsDir, file.name))) {
        const head = LINE_HEAD.exec(line);
        if (!head) continue;
        const atMs = Date.parse(head[1]!);
        if (!Number.isFinite(atMs)) continue;
        firstAtMs ??= atMs;
        if (lastLineAtMs === null || atMs > lastLineAtMs) lastLineAtMs = atMs;
        if (atMs < windowStartMs || atMs > windowEndMs) continue;
        const body = line.slice(head[0].length);
        if (body.startsWith(EVENT_DELIVERY)) {
          const sessionId = EVENT_DELIVERY_SESSION.exec(body)?.[1];
          if (!sessionId) continue;
          const entry = deliveries.get(sessionId) ?? { count: 0, lastAtMs: atMs, lastEventType: null };
          entry.count += 1;
          if (atMs >= entry.lastAtMs) {
            entry.lastAtMs = atMs;
            entry.lastEventType = EVENT_DELIVERY_TYPE.exec(body)?.[1] ?? null;
          }
          deliveries.set(sessionId, entry);
        } else if (keepRuntimeLogLine(head[2]!, body)) {
          kept.push(line.length > RUNTIME_LOG_MAX_LINE_CHARS ? `${line.slice(0, RUNTIME_LOG_MAX_LINE_CHARS)}…` : line);
        }
      }
    } catch (error) {
      if (read.length === 1) return { status: "unavailable", reason: errorText(error) };
      break;
    }
    keptNewestFirst.push(kept);
    if (firstAtMs !== null) {
      oldestLineAtMs = firstAtMs;
      if (firstAtMs <= windowStartMs) break;
    }
  }
  if (read.length === 0) return { status: "unavailable", reason: "the runtime log is larger than the read limit" };

  const lines = keptNewestFirst.reverse().flat();
  const earlierLinesOmitted = Math.max(0, lines.length - RUNTIME_LOG_MAX_LINES);
  return {
    status: "read",
    matchedBy: chosen.matchedBy,
    files: read,
    windowSeconds: RUNTIME_LOG_WINDOW_MS / 1_000,
    // A runtime younger than the window is covered from its first line.
    reachesWindowStart: oldestLineAtMs !== null
      && oldestLineAtMs <= Math.max(windowStartMs, chosen.log.startedAtMs + 5_000),
    lastLineAt: lastLineAtMs === null ? null : new Date(lastLineAtMs).toISOString(),
    eventDeliveries: [...deliveries]
      .sort(([, a], [, b]) => b.lastAtMs - a.lastAtMs)
      .map(([sessionId, entry]) => ({
        sessionId,
        count: entry.count,
        lastAt: new Date(entry.lastAtMs).toISOString(),
        lastEventType: entry.lastEventType,
      })),
    lines: lines.slice(earlierLinesOmitted),
    earlierLinesOmitted,
  };
}

export interface BackendLossRecordHandle {
  readonly fileName: string;
  /** Merges the patch and rewrites the file. */
  update(patch: Partial<BackendLossRecord>): void;
  /** Settles when every write requested so far has finished. */
  flushed(): Promise<void>;
}

export interface BackendLossRecorder {
  /** Writes the record now; the handle rewrites it as more becomes known. */
  open(record: BackendLossRecord): BackendLossRecordHandle;
}

export function createBackendLossRecorder(options: {
  directory: string;
  maxRecords?: number;
  logger?: Pick<Console, "warn">;
}): BackendLossRecorder {
  const logger = options.logger ?? console;
  return {
    open(initial) {
      let record = initial;
      const fileName = `${initial.at.replace(/[:.]/g, "-")}-${initial.reason.replace(/[^A-Za-z0-9-]/g, "")}.json`;
      const path = join(options.directory, fileName);
      let warned = false;
      const write = async (): Promise<void> => {
        try {
          const body = `${JSON.stringify(record, null, 2)}\n`;
          await mkdir(options.directory, { recursive: true });
          const temporary = `${path}.${process.pid}.tmp`;
          await writeFile(temporary, body, "utf8");
          try {
            await rename(temporary, path);
          } catch {
            // A scanner holding the previous version open blocks the replace on Windows.
            await writeFile(path, body, "utf8");
            await rm(temporary, { force: true });
          }
        } catch (error) {
          if (warned) return;
          warned = true;
          logger.warn(`[backend-loss] Could not write ${path}: ${errorText(error)}`);
        }
      };
      let queue: Promise<void> = write().then(() => pruneRetainedLogFiles({
        dir: options.directory,
        policy: { maxAgeMs: Number.POSITIVE_INFINITY, maxCount: options.maxRecords ?? MAX_RECORDS },
      })).then(() => undefined, () => undefined);
      return {
        fileName,
        update(patch) {
          record = { ...record, ...patch };
          queue = queue.then(write);
        },
        flushed: () => queue,
      };
    },
  };
}
