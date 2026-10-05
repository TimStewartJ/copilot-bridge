// Keeps a failed write to stdout or stderr from ending the process.
//
// The Bridge's processes log to files: stdout and stderr are redirected, and Node writes to a
// file synchronously. The operating system can refuse such a write. Seen on 2026-10-05: Windows
// error 1450 ("insufficient system resources") on a Dev Drive while the machine had no free
// memory, which Node reports as "UNKNOWN: unknown error, write".
//
// Node's console drops a line it cannot write, but only while nothing else listens for 'error'
// on the stream, and the output pipe of a worker thread does. The error was then unhandled, and
// it ended the server three times that day. A listener of our own keeps the process running.
// The lines are still lost, so the guard counts them and says so on both streams once writing
// has had time to recover.

import { freemem } from "node:os";
import { basename } from "node:path";

/** How long after a failed write the guard waits before it reports what was lost. */
export const STDIO_FAILURE_REPORT_DELAY_MS = 5_000;
/** The wait grows to this while the report itself cannot be written, so a dead stream costs one write now and then. */
export const STDIO_FAILURE_REPORT_MAX_DELAY_MS = 5 * 60_000;

export type GuardedStreamName = "stdout" | "stderr";

/** The part of process.stdout and process.stderr the guard uses. */
export interface GuardedStream {
  on(event: "error", listener: (error: Error) => void): unknown;
  write(text: string, callback?: (error?: Error | null) => void): unknown;
}

export interface StdioWriteGuardOptions {
  streams: Record<GuardedStreamName, GuardedStream>;
  reportDelayMs?: number;
  maxReportDelayMs?: number;
  /** Names the process in a report: several of them write to the same file. */
  processLabel?: string;
  now?: () => number;
  freeMemoryBytes?: () => number;
}

export interface StdioWriteGuard {
  /** Failed writes per stream since the guard was installed, reports that failed included. */
  failedWrites(): Record<GuardedStreamName, number>;
  /** Writes the report that is waiting, if any, without waiting for its timer. */
  reportNow(): void;
}

interface StreamFailures {
  total: number;
  unreported: number;
  firstAt: number;
  lastAt: number;
  lastError: string;
  lowestFreeMemoryBytes: number;
}

const STREAM_NAMES: readonly GuardedStreamName[] = ["stdout", "stderr"];

function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

export function createStdioWriteGuard(options: StdioWriteGuardOptions): StdioWriteGuard {
  const baseDelayMs = options.reportDelayMs ?? STDIO_FAILURE_REPORT_DELAY_MS;
  const maxDelayMs = Math.max(baseDelayMs, options.maxReportDelayMs ?? STDIO_FAILURE_REPORT_MAX_DELAY_MS);
  const now = options.now ?? Date.now;
  const freeMemoryBytes = options.freeMemoryBytes ?? freemem;
  const processLabel = options.processLabel ?? `pid ${process.pid}`;
  const failures: Record<GuardedStreamName, StreamFailures> = {
    stdout: { total: 0, unreported: 0, firstAt: 0, lastAt: 0, lastError: "", lowestFreeMemoryBytes: 0 },
    stderr: { total: 0, unreported: 0, firstAt: 0, lastAt: 0, lastError: "", lowestFreeMemoryBytes: 0 },
  };
  let delayMs = baseDelayMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReport = () => {
    if (timer) return;
    timer = setTimeout(report, delayMs);
    timer.unref?.();
  };

  const record = (name: GuardedStreamName, error: unknown) => {
    const entry = failures[name];
    const at = now();
    let free = Number.NaN;
    try {
      free = freeMemoryBytes();
    } catch {
      // The count matters more than the memory reading.
    }
    entry.total += 1;
    if (entry.unreported === 0) {
      entry.firstAt = at;
      entry.lowestFreeMemoryBytes = free;
    } else if (Number.isFinite(free) && !(entry.lowestFreeMemoryBytes <= free)) {
      entry.lowestFreeMemoryBytes = free;
    }
    entry.unreported += 1;
    entry.lastAt = at;
    entry.lastError = describeError(error);
    scheduleReport();
  };

  function report(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const lines: string[] = [];
    for (const name of STREAM_NAMES) {
      const entry = failures[name];
      if (entry.unreported === 0) continue;
      const count = entry.unreported;
      const memory = Number.isFinite(entry.lowestFreeMemoryBytes)
        ? ` Free memory then: ${Math.round(entry.lowestFreeMemoryBytes / (1024 * 1024))} MB.`
        : "";
      lines.push(
        `[${clockTime(now())}] [stdio] ${count} write${count === 1 ? "" : "s"} to ${name} failed between `
        + `${clockTime(entry.firstAt)} and ${clockTime(entry.lastAt)} UTC and ${count === 1 ? "its" : "their"} output is lost `
        + `(${processLabel}; ${entry.total} since it started). Last error: ${entry.lastError}.${memory}`,
      );
      entry.unreported = 0;
    }
    if (lines.length === 0) return;
    const text = `${lines.join("\n")}\n`;
    // Both streams: the gap is in one file, and the other is where errors are looked for. A
    // report that fails is counted like any other write and reported after a longer wait.
    const longerDelayMs = Math.min(delayMs * 2, maxDelayMs);
    let outstanding = STREAM_NAMES.length;
    let failed = false;
    const settle = (error: unknown) => {
      outstanding -= 1;
      if (error) {
        failed = true;
        delayMs = longerDelayMs;
      } else if (outstanding === 0 && !failed) {
        delayMs = baseDelayMs;
      }
    };
    for (const name of STREAM_NAMES) {
      try {
        options.streams[name].write(text, settle);
      } catch (error) {
        settle(error);
        record(name, error);
      }
    }
  }

  for (const name of STREAM_NAMES) {
    options.streams[name].on("error", (error) => record(name, error));
  }

  return {
    failedWrites: () => ({ stdout: failures.stdout.total, stderr: failures.stderr.total }),
    reportNow: report,
  };
}

let installed: StdioWriteGuard | undefined;

/** Guards this process's stdout and stderr. Safe to call more than once. */
export function installStdioWriteGuard(
  options: Omit<StdioWriteGuardOptions, "streams"> = {},
): StdioWriteGuard {
  installed ??= createStdioWriteGuard({
    processLabel: `${basename(process.argv[1] ?? "node")}, pid ${process.pid}`,
    ...options,
    streams: { stdout: process.stdout, stderr: process.stderr },
  });
  return installed;
}
