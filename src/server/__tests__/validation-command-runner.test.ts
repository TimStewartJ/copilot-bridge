import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildValidationCommandLogPath,
  getValidationCommandLogDir,
  resetValidationCommandLogSweepThrottle,
} from "../validation-command-log.js";
import { runStreamingValidationCommand } from "../validation-command-runner.js";
import { RETENTION_DAY_MS } from "../log-retention.js";
import { makeTestDir } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validation command runner retention", () => {
  it("sweeps the log directory after a streaming run without touching the fresh log", async () => {
    // The harness disables background sweeps so no test can delete real logs;
    // this test is specifically about that behavior, so it opts back in.
    vi.stubEnv("BRIDGE_DISABLE_BACKGROUND_LOG_RETENTION", "");
    const rootDir = makeTestDir("validation-runner-sweep");
    const logDir = getValidationCommandLogDir(rootDir);
    mkdirSync(logDir, { recursive: true });
    resetValidationCommandLogSweepThrottle();

    const agedAt = new Date(Date.now() - 400 * RETENTION_DAY_MS);
    const aged = buildValidationCommandLogPath({
      logDir,
      source: "staging",
      command: "git worktree prune",
      now: agedAt,
    });
    writeFileSync(aged, "aged");
    utimesSync(aged, agedAt, agedAt);

    const logPath = buildValidationCommandLogPath({
      logDir,
      source: "deploy-check-1",
      command: "node -e ok",
    });
    const result = await runStreamingValidationCommand({
      rootDir,
      source: "deploy-check-1",
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      displayCommand: "node -e ok",
      logPath,
      cwd: rootDir,
      env: process.env,
      shell: false,
    });

    expect(result.ok).toBe(true);
    expect(dirname(logPath)).toBe(logDir);
    await vi.waitFor(() => expect(existsSync(aged)).toBe(false));
    expect(existsSync(logPath)).toBe(true);
  });
});
