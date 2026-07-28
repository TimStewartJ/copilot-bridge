import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  buildCommandFailureOutput,
  buildValidationCommandLogPath,
  extractCommandFailureLogPath,
  extractCommandFailureLogWriteError,
  formatCommandFailureStreams,
  getValidationCommandLogDir,
  isCommandTimeoutError,
  isCommandTimeoutResult,
  parseValidationCommandLogTimestamp,
  pruneValidationCommandLogs,
  readValidationCommandLogTail,
  resetValidationCommandLogSweepThrottle,
  scheduleValidationCommandLogSweep,
  VALIDATION_LOG_TEMP_DIR_NAME,
  writeValidationCommandLog,
} from "../validation-command-log.js";
import { RETENTION_DAY_MS } from "../log-retention.js";
import { makeTestDir } from "./helpers.js";
import { pathBasename, testPath } from "./test-paths.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validation-command-log", () => {
  it("extracts the persisted validation log path from failure output", () => {
    const output = buildCommandFailureOutput({
      output: "vite exploded",
      elapsedMs: 1_200,
      timedOut: false,
      timeoutMs: 5_000,
      logPath: "/repo/data/validation-logs/vite.log",
    });

    expect(extractCommandFailureLogPath(output)).toBe("/repo/data/validation-logs/vite.log");
    expect(extractCommandFailureLogWriteError(output)).toBeUndefined();
  });

  it("extracts validation log write errors when persisting the full log fails", () => {
    const output = buildCommandFailureOutput({
      output: "tsc exploded",
      elapsedMs: 500,
      timedOut: false,
      timeoutMs: 5_000,
      logWriteError: "permission denied",
    });

    expect(extractCommandFailureLogPath(output)).toBeUndefined();
    expect(extractCommandFailureLogWriteError(output)).toBe("permission denied");
  });

  it("does not classify ENOBUFS SIGTERM failures as timeouts", () => {
    const error = { code: "ENOBUFS", signal: "SIGTERM" };

    expect(isCommandTimeoutError(error)).toBe(false);
    expect(isCommandTimeoutResult({
      error,
      signal: "SIGTERM",
      elapsedMs: 1_000,
      timeoutMs: 600_000,
    })).toBe(false);
  });

  it("classifies elapsed SIGTERM at the timeout boundary as a timeout", () => {
    expect(isCommandTimeoutResult({
      signal: "SIGTERM",
      elapsedMs: 600_000,
      timeoutMs: 600_000,
    })).toBe(true);
  });

  it("keeps both stdout and stderr in failure details", () => {
    expect(formatCommandFailureStreams({
      stdout: "normal output",
      stderr: "warning output",
      errorMessage: "spawn failed",
      fallback: "fallback",
    })).toBe([
      "failure:",
      "fallback",
      "",
      "stderr:",
      "warning output",
      "",
      "stdout:",
      "normal output",
      "",
      "error:",
      "spawn failed",
    ].join("\n"));
  });

  it("builds shared validation log paths and tails large logs", () => {
    const rootDir = makeTestDir("validation-log-tail");
    const logPath = buildValidationCommandLogPath({
      rootDir,
      source: "deploy-check-1",
      command: "npm run check:pr",
      now: new Date("2026-05-18T20:00:00.000Z"),
    });
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "abcdef");

    expect(basename(logPath)).toBe("2026-05-18T20-00-00-000Z-deploy-check-1-npm-run-check-pr.log");
    expect(readValidationCommandLogTail(logPath, 3)).toBe("[showing last 3 bytes]\ndef");
  });

  it("returns log write errors instead of throwing", () => {
    const rootDir = makeTestDir("validation-log-write-error");
    mkdirSync(join(rootDir, "data"), { recursive: true });
    writeFileSync(join(rootDir, "data", "validation-logs"), "not a directory");

    const result = writeValidationCommandLog({
      rootDir,
      source: "test",
      command: "npm run check:fast",
      cwd: rootDir,
      output: "boom",
      elapsedMs: 10,
      timedOut: false,
      timeoutMs: 1_000,
    });

    expect(result.path).toBeUndefined();
    expect(result.error).toContain("validation-logs");
  });
});

describe("validation-command-log retention", () => {
  const NOW_MS = Date.parse("2026-07-01T00:00:00.000Z");

  function seedLog(logDir: string, ageMs: number, label: string): string {
    const writtenAt = new Date(NOW_MS - ageMs);
    const logPath = buildValidationCommandLogPath({
      logDir,
      source: "staging",
      command: label,
      now: writtenAt,
    });
    writeFileSync(logPath, label);
    utimesSync(logPath, writtenAt, writtenAt);
    return logPath;
  }

  function makeLogDir(name: string): string {
    const rootDir = makeTestDir(name);
    const logDir = getValidationCommandLogDir(rootDir);
    mkdirSync(logDir, { recursive: true });
    resetValidationCommandLogSweepThrottle();
    return logDir;
  }

  it("parses the write time out of Bridge-owned log names", () => {
    const logPath = buildValidationCommandLogPath({
      logDir: testPath("validation-logs"),
      source: "staging",
      command: "git worktree prune",
      now: new Date("2026-05-18T20:00:00.000Z"),
    });

    expect(parseValidationCommandLogTimestamp(pathBasename(logPath)))
      .toBe(Date.parse("2026-05-18T20:00:00.000Z"));
    expect(parseValidationCommandLogTimestamp("not-a-bridge-log.log")).toBeNull();
  });

  it("deletes aged and excess logs while keeping the newest ones", async () => {
    const logDir = makeLogDir("validation-log-retention");
    const ancient = seedLog(logDir, 30 * RETENTION_DAY_MS, "ancient");
    const oldest = seedLog(logDir, 3 * RETENTION_DAY_MS, "oldest");
    const middle = seedLog(logDir, 2 * RETENTION_DAY_MS, "middle");
    const newest = seedLog(logDir, RETENTION_DAY_MS, "newest");

    const result = await pruneValidationCommandLogs({
      logDir,
      policy: { maxAgeMs: 14 * RETENTION_DAY_MS, maxCount: 2 },
      nowMs: NOW_MS,
      graceMs: 0,
    });

    expect(result.deleted).toBe(2);
    expect(existsSync(ancient)).toBe(false);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it("sweeps only aged crash leftovers from the transient capture directory", async () => {
    const logDir = makeLogDir("validation-log-temp-retention");
    const tempDir = join(logDir, VALIDATION_LOG_TEMP_DIR_NAME);
    mkdirSync(tempDir, { recursive: true });
    const leftover = join(tempDir, "1750000000000-42-abcd-stdout.log");
    const inFlight = join(tempDir, "1750000000001-43-efgh-stderr.log");
    writeFileSync(leftover, "leftover");
    writeFileSync(inFlight, "in flight");
    const aged = new Date(NOW_MS - 3 * RETENTION_DAY_MS);
    utimesSync(leftover, aged, aged);
    const fresh = new Date(NOW_MS - 60_000);
    utimesSync(inFlight, fresh, fresh);

    const result = await pruneValidationCommandLogs({
      logDir,
      policy: { maxAgeMs: 14 * RETENTION_DAY_MS, maxCount: 5_000 },
      nowMs: NOW_MS,
      graceMs: 0,
    });

    expect(result.deleted).toBe(1);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(inFlight)).toBe(true);
  });

  it("sweeps in the background after writing a failure log and then throttles", async () => {
    // The harness disables background sweeps so no test can delete real logs;
    // this test is specifically about that behavior, so it opts back in.
    vi.stubEnv("BRIDGE_DISABLE_BACKGROUND_LOG_RETENTION", "");
    const logDir = makeLogDir("validation-log-write-sweep");
    const rootDir = join(logDir, "..", "..");
    const ancient = seedLog(logDir, 400 * RETENTION_DAY_MS, "ancient");

    const written = writeValidationCommandLog({
      rootDir,
      source: "staging",
      command: "git worktree prune",
      cwd: rootDir,
      output: "boom",
      elapsedMs: 10,
      timedOut: false,
      timeoutMs: 1_000,
    });

    expect(written.path).toBeDefined();
    await vi.waitFor(() => expect(existsSync(ancient)).toBe(false));
    expect(existsSync(written.path as string)).toBe(true);
    await expect(scheduleValidationCommandLogSweep(logDir)).resolves.toBeNull();
  });

  it("never deletes logs written in the last few hours, even past the count cap", async () => {
    const logDir = makeLogDir("validation-log-live-writer");
    const liveWriter = seedLog(logDir, 30 * 60_000, "in-flight");
    const settled = seedLog(logDir, 12 * 60 * 60_000, "settled");

    const result = await pruneValidationCommandLogs({
      logDir,
      policy: { maxAgeMs: RETENTION_DAY_MS, maxCount: 0 },
      nowMs: NOW_MS,
    });

    expect(result.deleted).toBe(1);
    expect(result.skippedRecent).toBe(1);
    expect(existsSync(liveWriter)).toBe(true);
    expect(existsSync(settled)).toBe(false);
  });

  it("ignores an ambient log-dir override so an explicit rootDir always wins", async () => {
    // Deploy validation runs the suite with BRIDGE_VALIDATION_LOG_DIR pointed at the
    // live data dir. A caller that passes its own rootDir must never be redirected
    // there, or a sweep would delete real logs.
    const rootDir = makeTestDir("validation-log-ambient-override");
    const ambient = makeTestDir("validation-log-ambient-target");
    vi.stubEnv("BRIDGE_VALIDATION_LOG_DIR", ambient);

    expect(getValidationCommandLogDir(rootDir)).toBe(join(rootDir, "data", "validation-logs"));

    const written = writeValidationCommandLog({
      rootDir,
      source: "staging",
      command: "git worktree prune",
      cwd: rootDir,
      output: "boom",
      elapsedMs: 10,
      timedOut: false,
      timeoutMs: 1_000,
    });

    expect(written.path).toBeDefined();
    expect(dirname(written.path as string)).toBe(join(rootDir, "data", "validation-logs"));
    expect(readdirSync(ambient)).toEqual([]);
  });

  it("requires a root or log directory", async () => {
    await expect(pruneValidationCommandLogs({})).rejects.toThrow(/rootDir or logDir/);
  });
});
