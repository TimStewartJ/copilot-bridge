import { describe, expect, it } from "vitest";
import {
  buildCommandFailureOutput,
  extractCommandFailureLogPath,
  extractCommandFailureLogWriteError,
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
});
