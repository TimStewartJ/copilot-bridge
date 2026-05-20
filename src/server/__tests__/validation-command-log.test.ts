import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  buildCommandFailureOutput,
  buildValidationCommandLogPath,
  extractCommandFailureLogPath,
  extractCommandFailureLogWriteError,
  formatCommandFailureStreams,
  isCommandTimeoutError,
  isCommandTimeoutResult,
  readValidationCommandLogTail,
  writeValidationCommandLog,
} from "../validation-command-log.js";
import { makeTestDir } from "./helpers.js";

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
