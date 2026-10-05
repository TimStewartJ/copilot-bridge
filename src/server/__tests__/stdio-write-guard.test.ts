import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STDIO_FAILURE_REPORT_DELAY_MS,
  STDIO_FAILURE_REPORT_MAX_DELAY_MS,
  createStdioWriteGuard,
  type GuardedStream,
} from "../stdio-write-guard.js";

const REFUSED = Object.assign(new Error("UNKNOWN: unknown error, write"), { code: "UNKNOWN", errno: -4094 });

/** A stream that records what it is given. While `refusing` is set it fails each write the way Node does: the callback first, then 'error'. */
class FakeStream extends EventEmitter implements GuardedStream {
  written: string[] = [];
  refusing = false;

  write(text: string, callback?: (error?: Error | null) => void): boolean {
    if (this.refusing) {
      callback?.(REFUSED);
      this.emit("error", REFUSED);
      return false;
    }
    this.written.push(text);
    callback?.(null);
    return true;
  }

  /** A write of the program's own that the operating system refused. */
  failWrite(error: Error = REFUSED): void {
    this.emit("error", error);
  }
}

function createGuard(overrides: { freeMemoryBytes?: () => number } = {}) {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  let clock = Date.parse("2026-10-05T10:39:15.401Z");
  const guard = createStdioWriteGuard({
    streams: { stdout, stderr },
    processLabel: "index.js, pid 42",
    now: () => clock,
    freeMemoryBytes: overrides.freeMemoryBytes ?? (() => 12 * 1024 * 1024),
  });
  return { guard, stdout, stderr, advanceClock: (ms: number) => { clock += ms; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stdio write guard", () => {
  it("lets a failed write pass instead of leaving the error unhandled", () => {
    const { guard, stdout, stderr } = createGuard();

    expect(() => stdout.failWrite()).not.toThrow();
    expect(() => stderr.failWrite()).not.toThrow();
    stdout.failWrite();

    expect(guard.failedWrites()).toEqual({ stdout: 2, stderr: 1 });
  });

  it("reports on both streams what was lost, when, why, and how little memory was free", () => {
    const { guard, stdout, stderr, advanceClock } = createGuard();
    stdout.failWrite();
    advanceClock(2_600);
    stdout.failWrite();
    advanceClock(1_000);

    guard.reportNow();

    const line = "[10:39:19.001] [stdio] 2 writes to stdout failed between 10:39:15.401 and 10:39:18.001 UTC and "
      + "their output is lost (index.js, pid 42; 2 since it started). Last error: UNKNOWN: unknown error, write. "
      + "Free memory then: 12 MB.\n";
    expect(stdout.written).toEqual([line]);
    expect(stderr.written).toEqual([line]);
  });

  it("gives each stream its own line and counts on from the last report", () => {
    const { guard, stdout, stderr } = createGuard();
    stdout.failWrite();
    stderr.failWrite(new Error("EPIPE: broken pipe, write"));
    guard.reportNow();
    stdout.failWrite();
    guard.reportNow();

    expect(stdout.written[0]?.split("\n").slice(0, 2)).toEqual([
      expect.stringContaining("1 write to stdout failed"),
      expect.stringMatching(/1 write to stderr failed .* its output is lost .* Last error: EPIPE: broken pipe, write\./),
    ]);
    expect(stdout.written[1]).toContain("1 write to stdout failed");
    expect(stdout.written[1]).toContain("2 since it started");
    expect(stderr.written).toEqual(stdout.written);
  });

  it("reports the lowest free memory of a run of failures", () => {
    const readings = [900, 3, 40].map((megabytes) => megabytes * 1024 * 1024);
    const { guard, stdout } = createGuard({ freeMemoryBytes: () => readings.shift() ?? 0 });
    stdout.failWrite();
    stdout.failWrite();
    stdout.failWrite();
    guard.reportNow();

    expect(stdout.written[0]).toContain("Free memory then: 3 MB.");
  });

  it("writes nothing while nothing has failed", () => {
    const { guard, stdout, stderr } = createGuard();

    guard.reportNow();

    expect(stdout.written).toEqual([]);
    expect(stderr.written).toEqual([]);
  });

  it("reports by itself a few seconds after the first failure", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stdout } = createGuard();
    stdout.failWrite();
    stdout.failWrite();

    vi.advanceTimersByTime(STDIO_FAILURE_REPORT_DELAY_MS - 1);
    expect(stdout.written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stdout.written).toHaveLength(1);

    vi.advanceTimersByTime(STDIO_FAILURE_REPORT_MAX_DELAY_MS);
    expect(stdout.written, "one report for one run of failures").toHaveLength(1);
  });

  it("counts a report that cannot be written and waits longer each time before it tries again", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { guard, stdout, stderr } = createGuard();
    stdout.refusing = true;
    stdout.failWrite();

    vi.advanceTimersByTime(STDIO_FAILURE_REPORT_DELAY_MS);
    expect(stderr.written).toHaveLength(1);
    expect(guard.failedWrites().stdout, "the report to stdout failed too").toBe(2);

    vi.advanceTimersByTime(2 * STDIO_FAILURE_REPORT_DELAY_MS - 1);
    expect(stderr.written).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(stderr.written).toHaveLength(2);
    expect(guard.failedWrites().stdout).toBe(3);

    // stdout works again: the report gets through, and the wait is back to what it was.
    stdout.refusing = false;
    vi.advanceTimersByTime(4 * STDIO_FAILURE_REPORT_DELAY_MS);
    expect(stdout.written).toEqual([expect.stringContaining("1 write to stdout failed")]);
    expect(stdout.written[0]).toContain("3 since it started");
    stdout.failWrite();
    vi.advanceTimersByTime(STDIO_FAILURE_REPORT_DELAY_MS);
    expect(stdout.written).toHaveLength(2);
  });

  it("never waits longer than its limit between two tries", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { guard, stdout, stderr } = createGuard();
    stdout.refusing = true;
    stdout.failWrite();

    vi.advanceTimersByTime(24 * 60 * 60_000);
    const reports = stderr.written.length;
    vi.advanceTimersByTime(STDIO_FAILURE_REPORT_MAX_DELAY_MS);

    expect(stderr.written).toHaveLength(reports + 1);
    expect(guard.failedWrites().stdout).toBe(reports + 2);
  });
});
