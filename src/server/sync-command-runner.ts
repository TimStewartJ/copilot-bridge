import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildCommandFailureOutput,
  formatCommandFailureStreams,
  isCommandTimeoutResult,
  writeValidationCommandLog,
} from "./validation-command-log.js";

export interface SyncCommandRunOptions {
  rootDir: string;
  source: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface SyncCommandRunResult {
  ok: boolean;
  output: string;
  validationLogPath?: string;
  validationLogWriteError?: string;
}

function createOutputFile(rootDir: string, suffix: string): { path: string; fd: number } {
  const dir = join(rootDir, "data", "validation-logs", ".tmp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}-${suffix}.log`);
  return { path, fd: openSync(path, "w") };
}

function readOutput(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function cleanupOutputFile(path: string): void {
  rmSync(path, { force: true });
}

export function runSyncCommand(options: SyncCommandRunOptions): SyncCommandRunResult {
  const stdoutFile = createOutputFile(options.rootDir, "stdout");
  const stderrFile = createOutputFile(options.rootDir, "stderr");
  const startedAt = Date.now();
  try {
    const result = spawnSync(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      timeout: options.timeoutMs,
      windowsHide: true,
    });
    const elapsedMs = Date.now() - startedAt;
    closeSync(stdoutFile.fd);
    closeSync(stderrFile.fd);
    const stdout = readOutput(stdoutFile.path);
    const stderr = readOutput(stderrFile.path);

    if (result.status === 0 && !result.error && !result.signal) {
      return { ok: true, output: stdout };
    }

    const timedOut = isCommandTimeoutResult({
      error: result.error,
      signal: result.signal,
      elapsedMs,
      timeoutMs: options.timeoutMs,
    });
    const fallbackOutput = timedOut
      ? `Command timed out after ${Math.ceil(options.timeoutMs / 1_000)} seconds.`
      : result.signal
        ? `Command exited with signal ${result.signal}.`
        : `Command exited with code ${result.status ?? "unknown"}.`;
    const rawOutput = formatCommandFailureStreams({
      stdout,
      stderr,
      errorMessage: result.error?.message,
      fallback: fallbackOutput,
    });
    const annotatedOutput = buildCommandFailureOutput({
      output: rawOutput,
      elapsedMs,
      timedOut,
      timeoutMs: options.timeoutMs,
    });
    const logResult = writeValidationCommandLog({
      rootDir: options.rootDir,
      source: options.source,
      command: options.command,
      cwd: options.cwd,
      output: annotatedOutput,
      elapsedMs,
      timedOut,
      timeoutMs: options.timeoutMs,
    });

    return {
      ok: false,
      output: buildCommandFailureOutput({
        output: rawOutput,
        elapsedMs,
        timedOut,
        timeoutMs: options.timeoutMs,
        logPath: logResult.path,
        logWriteError: logResult.error,
      }),
      validationLogPath: logResult.path,
      validationLogWriteError: logResult.error,
    };
  } finally {
    try { closeSync(stdoutFile.fd); } catch {}
    try { closeSync(stderrFile.fd); } catch {}
    cleanupOutputFile(stdoutFile.path);
    cleanupOutputFile(stderrFile.path);
  }
}
