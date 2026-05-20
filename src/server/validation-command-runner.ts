import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  appendCapturedCommandOutput,
  joinFailureSections,
  renderCapturedCommandOutput,
  type CapturedCommandOutput,
} from "./staging-command-utils.js";
import {
  buildCommandFailureOutput,
  buildValidationCommandLogPath,
  formatCommandFailureStreams,
  isCommandTimeoutResult,
  writeValidationCommandLog,
} from "./validation-command-log.js";

export interface ValidationCommandRunResult {
  ok: boolean;
  output: string;
  validationLogPath?: string;
  validationLogWriteError?: string;
}

export interface AsyncValidationCommandRunOptions {
  rootDir: string;
  source: string;
  command: string;
  args?: readonly string[];
  displayCommand?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell?: boolean;
  killProcessTree?: (pid: number) => unknown;
  failureOutputFormat?: ValidationCommandFailureOutputFormat;
}

export interface SyncValidationCommandRunOptions {
  rootDir: string;
  source: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface StreamingValidationCommandRunOptions {
  rootDir: string;
  source: string;
  command: string;
  args?: readonly string[];
  displayCommand?: string;
  logPath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell?: boolean;
  timeoutMs?: number;
  killProcessTree?: (pid: number) => unknown;
}

export interface StreamingValidationCommandRunResult extends ValidationCommandRunResult {
  elapsedMs: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
}

interface CommandFailureDetails {
  rootDir: string;
  source: string;
  command: string;
  cwd: string;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
  status: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  elapsedMs: number;
  timedOut: boolean;
  timeoutMs: number;
  logPath?: string;
  logWriteError?: string;
  failureOutputFormat?: ValidationCommandFailureOutputFormat;
}

type ValidationCommandFailureOutputFormat = "labeled" | "plain";

function displayCommand(options: { command: string; args?: readonly string[]; displayCommand?: string }): string {
  return options.displayCommand ?? [options.command, ...(options.args ?? [])].join(" ");
}

export function formatValidationCommandExitReason({
  status,
  signal,
  timedOut,
  timeoutMs,
}: {
  status: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  timedOut: boolean;
  timeoutMs?: number;
}): string {
  if (timedOut && timeoutMs !== undefined) {
    return `timeout after ${Math.ceil(timeoutMs / 1_000)} seconds`;
  }
  return signal ? `signal ${signal}` : `exit code ${status ?? "unknown"}`;
}

function formatFailureFallback({
  status,
  signal,
  timedOut,
  timeoutMs,
}: Pick<CommandFailureDetails, "status" | "signal" | "timedOut" | "timeoutMs">): string {
  if (timedOut) return `Command timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`;
  if (signal) return `Command exited with signal ${signal}.`;
  return `Command exited with code ${status ?? "unknown"}.`;
}

function formatLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatValidationCommandFailureResult({
  rootDir,
  source,
  command,
  cwd,
  stdout,
  stderr,
  errorMessage,
  status,
  signal,
  elapsedMs,
  timedOut,
  timeoutMs,
  logPath,
  logWriteError,
  failureOutputFormat = "labeled",
}: CommandFailureDetails): ValidationCommandRunResult {
  const fallback = formatFailureFallback({ status, signal, timedOut, timeoutMs });
  const rawOutput = failureOutputFormat === "plain"
    ? joinFailureSections(stderr, stdout, errorMessage) ?? fallback
    : formatCommandFailureStreams({
      stdout,
      stderr,
      errorMessage,
      fallback,
    });
  let validationLogPath = logPath;
  let validationLogWriteError = logWriteError;

  if (!validationLogPath && !validationLogWriteError) {
    const annotatedOutput = buildCommandFailureOutput({
      output: rawOutput,
      elapsedMs,
      timedOut,
      timeoutMs,
    });
    const logResult = writeValidationCommandLog({
      rootDir,
      source,
      command,
      cwd,
      output: annotatedOutput,
      elapsedMs,
      timedOut,
      timeoutMs,
    });
    validationLogPath = logResult.path;
    validationLogWriteError = logResult.error;
  }

  return {
    ok: false,
    output: buildCommandFailureOutput({
      output: rawOutput,
      elapsedMs,
      timedOut,
      timeoutMs,
      logPath: validationLogPath,
      logWriteError: validationLogWriteError,
    }),
    validationLogPath,
    validationLogWriteError,
  };
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

function closeFile(file: { fd: number; closed: boolean }): void {
  if (file.closed) return;
  closeSync(file.fd);
  file.closed = true;
}

export function runSyncValidationCommand(options: SyncValidationCommandRunOptions): ValidationCommandRunResult {
  const stdoutFile = { ...createOutputFile(options.rootDir, "stdout"), closed: false };
  const stderrFile = { ...createOutputFile(options.rootDir, "stderr"), closed: false };
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
      command: options.command,
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

function spawnShell(options: Pick<AsyncValidationCommandRunOptions, "args" | "shell">): boolean {
  return options.shell ?? (!options.args || options.args.length === 0);
}

function stopChild(
  child: ReturnType<typeof spawn>,
  killProcessTree: ((pid: number) => unknown) | undefined,
): void {
  if (child.pid) {
    if (killProcessTree) {
      killProcessTree(child.pid);
      return;
    }
    child.kill("SIGKILL");
    return;
  }
  child.kill("SIGKILL");
}

export async function runValidationCommand(
  options: AsyncValidationCommandRunOptions,
): Promise<ValidationCommandRunResult> {
  const startedAt = Date.now();
  const command = displayCommand(options);

  return await new Promise((resolve) => {
    const child = options.args
      ? spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: spawnShell(options),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      : spawn(options.command, {
        cwd: options.cwd,
        env: options.env,
        shell: spawnShell(options),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    const stdout: CapturedCommandOutput = { output: "", truncatedChars: 0 };
    const stderr: CapturedCommandOutput = { output: "", truncatedChars: 0 };
    let spawnError: Error | undefined;
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);

      const stdoutOutput = renderCapturedCommandOutput("stdout", stdout);
      const stderrOutput = renderCapturedCommandOutput("stderr", stderr);

      if (code === 0 && !timedOut && !spawnError) {
        resolve({ ok: true, output: stdoutOutput });
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      resolve(formatValidationCommandFailureResult({
        rootDir: options.rootDir,
        source: options.source,
        command,
        cwd: options.cwd,
        stdout: stdoutOutput,
        stderr: stderrOutput,
        errorMessage: spawnError?.message,
        status: code,
        signal,
        elapsedMs,
        timedOut,
        timeoutMs: options.timeoutMs,
        failureOutputFormat: options.failureOutputFormat,
      }));
    };

    const timeout = options.timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        stopChild(child, options.killProcessTree);
      }, options.timeoutMs)
      : undefined;

    child.stdout?.on("data", (chunk) => {
      appendCapturedCommandOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendCapturedCommandOutput(stderr, chunk);
    });
    child.on("error", (err) => {
      spawnError = err;
      finish(null, null);
    });
    child.on("close", finish);
  });
}

function writeOutputLogChunk(
  fd: number | undefined,
  chunk: unknown,
  onError: (error: unknown) => void,
): void {
  if (fd === undefined) return;
  try {
    if (typeof chunk === "string") {
      writeSync(fd, chunk);
    } else if (chunk instanceof Uint8Array) {
      writeSync(fd, chunk);
    } else {
      writeSync(fd, String(chunk));
    }
  } catch (error) {
    onError(error);
  }
}

export async function runStreamingValidationCommand(
  options: StreamingValidationCommandRunOptions,
): Promise<StreamingValidationCommandRunResult> {
  const startedAt = Date.now();
  const command = displayCommand(options);
  const timeoutMs = options.timeoutMs ?? 0;
  const logPath = options.logPath ?? buildValidationCommandLogPath({
    rootDir: options.rootDir,
    source: options.source,
    command,
  });
  let logFd: number | undefined;

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, "w");
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const reason = `log open failed: ${formatLogError(error)}`;
    const failure = formatValidationCommandFailureResult({
      rootDir: options.rootDir,
      source: options.source,
      command,
      cwd: options.cwd,
      errorMessage: `Unable to write full command output: ${formatLogError(error)}`,
      status: null,
      signal: null,
      elapsedMs,
      timedOut: false,
      timeoutMs,
      logWriteError: formatLogError(error),
    });
    return { ...failure, elapsedMs, status: null, signal: null, reason };
  }

  return await new Promise((resolve) => {
    const child = options.args
      ? spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: spawnShell(options),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      : spawn(options.command, {
        cwd: options.cwd,
        env: options.env,
        shell: spawnShell(options),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    const stdout: CapturedCommandOutput = { output: "", truncatedChars: 0 };
    const stderr: CapturedCommandOutput = { output: "", truncatedChars: 0 };
    let spawnError: Error | undefined;
    let timedOut = false;
    let logWriteError: string | undefined;
    let settled = false;

    const closeLog = (): void => {
      if (logFd === undefined) return;
      closeSync(logFd);
      logFd = undefined;
    };

    const handleLogWriteError = (error: unknown): void => {
      if (logWriteError) return;
      logWriteError = formatLogError(error);
      closeLog();
      stopChild(child, options.killProcessTree);
    };

    const timeout = options.timeoutMs === undefined || options.timeoutMs <= 0
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        stopChild(child, options.killProcessTree);
      }, options.timeoutMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      closeLog();

      const elapsedMs = Date.now() - startedAt;
      const reason = formatValidationCommandExitReason({
        status: code,
        signal,
        timedOut,
        timeoutMs: options.timeoutMs,
      });
      const stdoutOutput = renderCapturedCommandOutput("stdout", stdout);
      const stderrOutput = renderCapturedCommandOutput("stderr", stderr);

      if (code === 0 && !timedOut && !spawnError && !logWriteError) {
        resolve({
          ok: true,
          output: stdoutOutput,
          validationLogPath: logPath,
          elapsedMs,
          status: code,
          signal,
          reason,
        });
        return;
      }

      const failure = formatValidationCommandFailureResult({
        rootDir: options.rootDir,
        source: options.source,
        command,
        cwd: options.cwd,
        stdout: stdoutOutput,
        stderr: stderrOutput,
        errorMessage: spawnError?.message,
        status: code,
        signal,
        elapsedMs,
        timedOut,
        timeoutMs,
        logPath: logWriteError ? undefined : logPath,
        logWriteError,
      });
      resolve({ ...failure, elapsedMs, status: code, signal, reason });
    };

    child.stdout?.on("data", (chunk) => {
      appendCapturedCommandOutput(stdout, chunk);
      writeOutputLogChunk(logFd, chunk, handleLogWriteError);
    });
    child.stderr?.on("data", (chunk) => {
      appendCapturedCommandOutput(stderr, chunk);
      writeOutputLogChunk(logFd, chunk, handleLogWriteError);
    });
    child.on("error", (err) => {
      spawnError = err;
      finish(null, null);
    });
    child.on("close", finish);
  });
}
