// Launcher only, where blocking is fine; server code starts processes via the process host.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  displayCommand,
  formatValidationCommandFailureResult,
  type ValidationCommandRunResult,
} from "./validation-command-runner.js";
import { isCommandTimeoutResult } from "./validation-command-log.js";
import type { CommandSpec } from "./shell-command.js";

export type SyncCommandRunOptions = CommandSpec & {
  rootDir: string;
  source: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};

export type SyncCommandRunResult = ValidationCommandRunResult;

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

function closeFile(file: { fd: number; closed: boolean }): void {
  if (file.closed) return;
  closeSync(file.fd);
  file.closed = true;
}

export function runSyncCommand(options: SyncCommandRunOptions): SyncCommandRunResult {
  const stdoutFile = { ...createOutputFile(options.rootDir, "stdout"), closed: false };
  const stderrFile = { ...createOutputFile(options.rootDir, "stderr"), closed: false };
  const startedAt = Date.now();
  const command = displayCommand(options);
  try {
    const spawnOptions: SpawnSyncOptions = {
      cwd: options.cwd,
      env: options.env,
      // Only constant ShellCommand text goes to a shell; a program with arguments never does.
      shell: options.args === undefined,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      timeout: options.timeoutMs,
      windowsHide: true,
    };
    const result = options.args
      ? spawnSync(options.command, [...options.args], spawnOptions)
      : spawnSync(options.command, spawnOptions);
    const elapsedMs = Date.now() - startedAt;
    closeFile(stdoutFile);
    closeFile(stderrFile);
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

    return formatValidationCommandFailureResult({
      rootDir: options.rootDir,
      source: options.source,
      command,
      cwd: options.cwd,
      stdout,
      stderr,
      errorMessage: result.error?.message,
      status: result.status,
      signal: result.signal,
      elapsedMs,
      timedOut,
      timeoutMs: options.timeoutMs,
    });
  } finally {
    closeFile(stdoutFile);
    closeFile(stderrFile);
    cleanupOutputFile(stdoutFile.path);
    cleanupOutputFile(stderrFile.path);
  }
}
