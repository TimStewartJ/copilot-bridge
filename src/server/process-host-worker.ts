// The only module in the server runtime that creates child processes or deletes directory trees.
//
// On Windows, process creation is a synchronous CreateProcessW call on the calling thread, and
// under machine load that call has been measured taking tens of seconds. The process host loads
// this module as a worker thread so that stall never lands on the server's main event loop. The
// inline backend (tests, operational fallback) calls the same functions on its own thread.
// Deleting a tree is the same kind of call: rmSync holds its thread for the whole delete, and a
// worktree is tens of thousands of files.
//
// Constraints: `new Worker()` loads this file from compiled JS, from tsx, and from Vitest, where
// loader hooks are not reliably inherited. It therefore has no runtime imports from the codebase
// (type imports are erased) and uses only erasable TypeScript syntax.

import { exec, execFile, fork, spawn, type ChildProcess, type ForkOptions, type SpawnOptions } from "node:child_process";
import { rmSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type {
  HostEvent,
  HostExecOutcome,
  HostExecRequest,
  HostRequest,
  HostSpawnOptions,
  SerializedExecError,
  SerializedHostError,
} from "./process-host-protocol.js";

/** Marks a thread started by the process host. Other worker threads (Vitest's) import this module too. */
export const PROCESS_HOST_WORKER_FLAG = "bridgeProcessHostWorker";

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  return value === undefined || value === null ? "" : String(value);
}

function serializeExecError(error: unknown): SerializedExecError {
  const e = error as NodeJS.ErrnoException & {
    spawnargs?: string[]; cmd?: string; killed?: boolean; signal?: NodeJS.Signals | null;
  };
  return {
    message: e?.message ?? String(error),
    name: e?.name,
    code: typeof e?.code === "number" || typeof e?.code === "string" ? e.code : null,
    errno: typeof e?.errno === "number" ? e.errno : undefined,
    syscall: e?.syscall,
    path: e?.path,
    spawnargs: Array.isArray(e?.spawnargs) ? e.spawnargs : undefined,
    cmd: e?.cmd,
    killed: e?.killed === true,
    signal: e?.signal ?? null,
  };
}

function isCompleteJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one command to completion with Node's own execFile/exec semantics (timeout, maxBuffer,
 * error shape). Never rejects: failures travel in the outcome so they can cross a thread boundary.
 */
export function execToOutcome(
  request: HostExecRequest,
  onCreated?: (createMs: number) => void,
  signal?: AbortSignal,
): Promise<HostExecOutcome> {
  return new Promise((resolve) => {
    const { completeWhen, ...nodeOptions } = request.options;
    const options = { ...nodeOptions, ...(signal ? { signal } : {}) };
    let streamedStdout = "";
    let streamedStderr = "";
    let settled = false;
    let createMs = 0;
    let child: ChildProcess | undefined;

    const finish = (outcome: Omit<HostExecOutcome, "createMs">): void => {
      if (settled) return;
      settled = true;
      resolve({ ...outcome, createMs });
    };

    const onExit = (error: unknown, stdoutValue: unknown, stderrValue: unknown): void => {
      // A promisified execFile mock delivers { stdout, stderr } as its single result value.
      const wrapped = stdoutValue && typeof stdoutValue === "object" && !(stdoutValue instanceof Uint8Array)
        ? stdoutValue as { stdout?: unknown; stderr?: unknown }
        : undefined;
      const failure = error as { stdout?: unknown; stderr?: unknown } | null;
      const stdout = text(wrapped ? wrapped.stdout : stdoutValue) || text(failure?.stdout) || streamedStdout;
      const stderr = text(wrapped ? wrapped.stderr : stderrValue) || text(failure?.stderr) || streamedStderr;
      finish({ stdout, stderr, ...(error ? { error: serializeExecError(error) } : {}) });
    };

    const startedAt = performance.now();
    try {
      if (request.kind === "exec") {
        const { shell, ...execOptions } = options;
        child = exec(request.command, { ...execOptions, ...(typeof shell === "string" ? { shell } : {}) }, onExit);
      } else {
        child = execFile(request.file, request.args, options, onExit);
      }
    } catch (error) {
      createMs = performance.now() - startedAt;
      onCreated?.(createMs);
      finish({ stdout: "", stderr: "", error: serializeExecError(error) });
      return;
    }
    createMs = performance.now() - startedAt;
    onCreated?.(createMs);

    if (completeWhen === "stdout-json") {
      child?.stderr?.on("data", (chunk) => {
        streamedStderr += text(chunk);
      });
      child?.stdout?.on("data", (chunk) => {
        streamedStdout += text(chunk);
        if (settled || !isCompleteJson(streamedStdout)) return;
        finish({ stdout: streamedStdout, stderr: streamedStderr });
        try {
          child?.kill();
        } catch {
          // The client may already have exited on its own.
        }
      });
    }
  });
}

/** Keeps the retry policy staging cleanup always used. Any wait is on this thread, not the server's. */
export function removeTreeOnCallingThread(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

/** Inline backend only: creates the process on the calling thread and returns the real handle. */
export function spawnOnCallingThread(file: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  return args.length === 0 ? spawn(file, options) : spawn(file, [...args], options);
}

/** Inline backend only: forks on the calling thread and returns the real handle. */
export function forkOnCallingThread(modulePath: string, args: readonly string[], options: ForkOptions): ChildProcess {
  return fork(modulePath, [...args], options);
}

function serializeError(error: unknown): SerializedHostError {
  const e = error as NodeJS.ErrnoException & { spawnargs?: string[] };
  return {
    message: e?.message ?? String(error),
    name: e?.name,
    code: typeof e?.code === "string" ? e.code : undefined,
    errno: typeof e?.errno === "number" ? e.errno : undefined,
    syscall: e?.syscall,
    path: e?.path,
    spawnargs: Array.isArray(e?.spawnargs) ? e.spawnargs : undefined,
  };
}

function toBytes(chunk: unknown): Uint8Array {
  return typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array);
}

function createChild(file: string, args: string[], options: HostSpawnOptions): ChildProcess {
  const stdio = [options.stdin, options.stdout, options.stderr];
  const common = {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv | undefined,
    windowsHide: options.windowsHide,
    detached: options.detached,
    serialization: options.serialization,
  };
  if (options.mode === "fork") {
    return fork(file, args, { ...common, execArgv: options.execArgv, stdio: [...stdio, "ipc"] });
  }
  return spawn(file, args, {
    ...common,
    shell: options.shell,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    stdio: options.ipc ? [...stdio, "ipc"] : stdio,
  });
}

function serveProcessHost(port: NonNullable<typeof parentPort>): void {
  const children = new Map<number, ChildProcess>();
  const runningExecs = new Map<number, AbortController>();
  const post = (event: HostEvent): void => port.postMessage(event);

  const handleExec = (request: Extract<HostRequest, { type: "exec" }>): void => {
    const { id } = request;
    const controller = new AbortController();
    runningExecs.set(id, controller);
    void execToOutcome(
      request.request,
      (createMs) => post({ type: "exec-created", id, createMs }),
      controller.signal,
    ).then((outcome) => {
      runningExecs.delete(id);
      post({ type: "exec-done", id, outcome });
    });
  };

  const handleSpawn = (request: Extract<HostRequest, { type: "spawn" }>): void => {
    const { id } = request;
    const startedAt = performance.now();
    let child: ChildProcess;
    try {
      child = createChild(request.file, request.args, request.options);
    } catch (error) {
      post({ type: "error", id, error: serializeError(error), createMs: performance.now() - startedAt });
      return;
    }
    const createMs = performance.now() - startedAt;

    if (child.pid === undefined) {
      // A failed spawn (for example ENOENT) reports once through "error". The host treats an
      // error that arrives before "spawned" as terminal, so nothing else is relayed.
      child.once("error", (error) => post({ type: "error", id, error: serializeError(error), createMs }));
      return;
    }

    children.set(id, child);
    child.on("error", (error) => post({ type: "error", id, error: serializeError(error) }));
    child.stdout?.on("data", (chunk) => post({ type: "stdout", id, chunk: toBytes(chunk) }));
    child.stderr?.on("data", (chunk) => post({ type: "stderr", id, chunk: toBytes(chunk) }));
    child.on("message", (message) => post({ type: "message", id, message }));
    child.on("disconnect", () => post({ type: "disconnect", id }));
    child.on("exit", (code, signal) => post({ type: "exit", id, code, signal }));
    child.on("close", (code, signal) => {
      children.delete(id);
      post({ type: "close", id, code, signal });
    });
    post({ type: "spawned", id, pid: child.pid, createMs });
  };

  port.on("message", (request: HostRequest) => {
    if (request.type === "exec") return handleExec(request);
    if (request.type === "spawn") return handleSpawn(request);
    if (request.type === "cancel") {
      runningExecs.get(request.id)?.abort();
      return;
    }
    if (request.type === "remove-tree") {
      try {
        removeTreeOnCallingThread(request.path);
        post({ type: "tree-removed", id: request.id });
      } catch (error) {
        post({ type: "tree-removed", id: request.id, error: serializeError(error) });
      }
      return;
    }

    const child = children.get(request.id);
    if (!child) {
      if (request.type === "send") {
        post({
          type: "sent",
          id: request.id,
          seq: request.seq,
          error: { message: "Child process is not running", code: "ERR_IPC_CHANNEL_CLOSED" },
        });
      }
      return;
    }
    switch (request.type) {
      case "stdin":
        if (request.chunk === null) child.stdin?.end();
        else child.stdin?.write(request.chunk);
        return;
      case "send":
        try {
          child.send(request.message as never, (error) => {
            post({ type: "sent", id: request.id, seq: request.seq, ...(error ? { error: serializeError(error) } : {}) });
          });
        } catch (error) {
          post({ type: "sent", id: request.id, seq: request.seq, error: serializeError(error) });
        }
        return;
      case "kill":
        try {
          child.kill(request.signal);
        } catch {
          // The child may already be gone; its exit event reports the outcome.
        }
        return;
      case "disconnect":
        if (child.connected) child.disconnect();
        return;
    }
  });
}

if (parentPort && (workerData as Record<string, unknown> | null)?.[PROCESS_HOST_WORKER_FLAG] === true) {
  serveProcessHost(parentPort);
}
