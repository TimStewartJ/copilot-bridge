import { describe, expect, it } from "vitest";
import {
  buildCommandFailureOutput,
  extractCommandFailureLogPath,
  extractCommandFailureLogWriteError,
  formatCommandFailureStreams,
  isCommandTimeoutError,
  isCommandTimeoutResult,
} from "../validation-command-log.js";

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
});
