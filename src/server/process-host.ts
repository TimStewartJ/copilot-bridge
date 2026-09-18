// Process host: the server runtime's only way to start a child process.
//
// On Windows, creating a process is a synchronous CreateProcessW call on the calling thread.
// Under machine load that call has been measured taking tens of seconds, and while it runs the
// calling thread's event loop serves nothing: no HTTP, no health probe, no session event
// acknowledgement. The host therefore performs every process creation on worker threads.
//
//   execFile / exec   run a command to completion on a small pool of worker threads.
//   spawn / fork      start a long-lived child on its own dedicated worker thread, so relaying
//                     its output and IPC is never stuck behind another slow process creation.
//   removeTree        delete a directory tree on its own worker thread. It is the same kind of
//                     call: rmSync holds its thread for the whole delete.
//
// Deadlines are enforced on the calling thread: a command whose process cannot even be created
// in time fails with a timeout instead of holding its caller for the length of the stall.

import type { ForkOptions, Serializable, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough, Writable, type Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  HostExecError,
  type HostEvent,
  type HostExecOptions,
  type HostExecOutcome,
  type HostExecRequest,
  type HostRequest,
  type HostSpawnOptions,
  type HostStdio,
  type SerializedHostError,
} from "./process-host-protocol.js";

export { HostExecError, type HostExecOptions } from "./process-host-protocol.js";

export type ProcessHostMode = "worker" | "inline";

/** The part of ChildProcess the server runtime uses. Real ChildProcess objects satisfy it too. */
export interface HostChild extends NodeJS.EventEmitter {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  readonly connected: boolean;
  send(message: Serializable, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  disconnect(): void;
  ref(): void;
  unref(): void;
}

export interface ProcessLaunchObservation {
  kind: "exec" | "spawn" | "fork";
  file: string;
  /** How long the operating system took to create the process. */
  createMs: number;
  /** How long the request waited for a worker thread that was free to create it. */
  queuedMs: number;
}

/** The part of a worker thread the host uses. Tests substitute a scripted one. */
export type HostWorker = Pick<Worker, "postMessage" | "on" | "ref" | "unref" | "terminate">;

export interface ProcessHostOptions {
  mode?: ProcessHostMode;
  maxPoolWorkers?: number;
  onLaunch?: (observation: ProcessLaunchObservation) => void;
  createWorker?: () => HostWorker;
}

/** Must match PROCESS_HOST_WORKER_FLAG in process-host-worker.ts, which the main thread never imports in worker mode. */
const WORKER_FLAG = "bridgeProcessHostWorker";
const DEFAULT_MAX_POOL_WORKERS = 4;
/** Lets the worker's own timeout, which carries partial output, win over the calling-thread deadline. */
const DEADLINE_GRACE_MS = 1_000;

/**
 * Locates a worker module that sits beside the caller, such as "process-host-worker".
 * Compiled builds load the .js worker and inherit execArgv. Source runs (tsx, Vitest) load the
 * .ts worker with the tsx loader passed explicitly: loader hooks registered by a tsx parent are
 * not reliably inherited by worker threads. Inherited execArgv is never re-passed, because
 * `new Worker` rejects process-level flags that inheritance silently tolerates.
 */
export function resolveWorkerEntry(name: string, moduleUrl = import.meta.url): { entry: string; execArgv?: string[] } {
  const isSource = moduleUrl.endsWith(".ts");
  const entry = join(dirname(fileURLToPath(moduleUrl)), `${name}.${isSource ? "ts" : "js"}`);
  if (isSource) {
    return { entry, execArgv: ["--import", pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href] };
  }
  return { entry };
}

function startWorkerThread(): HostWorker {
  const { entry, execArgv } = resolveWorkerEntry("process-host-worker");
  return new Worker(entry, { workerData: { [WORKER_FLAG]: true }, ...(execArgv ? { execArgv } : {}) });
}

function toError(serialized: SerializedHostError): NodeJS.ErrnoException & { spawnargs?: string[] } {
  const error = new Error(serialized.message) as NodeJS.ErrnoException & { spawnargs?: string[] };
  if (serialized.name) error.name = serialized.name;
  error.code = serialized.code;
  error.errno = serialized.errno;
  error.syscall = serialized.syscall;
  error.path = serialized.path;
  error.spawnargs = serialized.spawnargs;
  return error;
}

function toHostStdio(value: unknown, index: number): HostStdio {
  if (value === undefined || value === null || value === "pipe" || value === "overlapped") return "pipe";
  if (value === "ignore") return "ignore";
  throw new TypeError(
    `The process host supports only "pipe" and "ignore" for stdio[${index}] (got ${JSON.stringify(value)}): `
    + "streams and inherited handles cannot cross a thread boundary.",
  );
}

const SUPPORTED_SPAWN_OPTIONS = new Set([
  "cwd", "env", "shell", "windowsHide", "windowsVerbatimArguments", "detached", "stdio", "serialization", "execArgv",
]);

function toHostSpawnOptions(options: SpawnOptions | ForkOptions, mode: "spawn" | "fork"): HostSpawnOptions {
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !SUPPORTED_SPAWN_OPTIONS.has(key)) {
      throw new TypeError(`The process host does not support the "${key}" option for ${mode}.`);
    }
  }
  const stdio = options.stdio;
  const entries: unknown[] = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
  const extra = entries.slice(3);
  if (extra.some((entry) => entry !== "ipc") || extra.length > 1) {
    throw new TypeError('The process host supports at most one extra stdio entry, and it must be "ipc".');
  }
  const spawnOptions = options as SpawnOptions;
  return {
    cwd: typeof options.cwd === "string" ? options.cwd : options.cwd ? fileURLToPath(options.cwd) : undefined,
    env: options.env ? { ...options.env } : liveEnv(),
    shell: spawnOptions.shell,
    windowsHide: spawnOptions.windowsHide,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    detached: options.detached,
    stdin: toHostStdio(entries[0], 0),
    stdout: toHostStdio(entries[1], 1),
    stderr: toHostStdio(entries[2], 2),
    ipc: mode === "fork" || extra.length === 1,
    serialization: options.serialization,
    mode,
    execArgv: mode === "fork" ? (options as ForkOptions).execArgv : undefined,
  };
}

/** ChildProcess-shaped handle for a child that lives on a dedicated worker thread. */
class HostedChildProcess extends EventEmitter implements HostChild {
  readonly stdin: Writable | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  connected: boolean;
  private closed = false;
  private sendSeq = 0;
  private readonly sendCallbacks = new Map<number, (error: Error | null) => void>();

  constructor(
    readonly pid: number | undefined,
    private readonly id: number,
    private readonly worker: HostWorker,
    options: HostSpawnOptions,
  ) {
    super();
    this.connected = options.ipc && pid !== undefined;
    this.stdout = options.stdout === "pipe" ? new PassThrough() : null;
    this.stderr = options.stderr === "pipe" ? new PassThrough() : null;
    this.stdin = options.stdin === "pipe"
      ? new Writable({
        write: (chunk: Buffer, _encoding, callback) => {
          this.post({ type: "stdin", id: this.id, chunk });
          callback();
        },
        final: (callback) => {
          this.post({ type: "stdin", id: this.id, chunk: null });
          callback();
        },
      })
      : null;
  }

  private post(request: HostRequest): void {
    if (!this.closed) this.worker.postMessage(request);
  }

  /** An "error" event with no listener throws. A missing listener must never take the server down. */
  private report(error: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", error);
    else console.warn(`[process-host] Unhandled child process error (pid ${this.pid}): ${error.message}`);
  }

  send(message: Serializable, callback?: (error: Error | null) => void): boolean {
    if (!this.connected || this.closed) {
      const error = Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
      if (callback) process.nextTick(callback, error);
      else process.nextTick(() => this.report(error));
      return false;
    }
    const seq = ++this.sendSeq;
    if (callback) this.sendCallbacks.set(seq, callback);
    this.post({ type: "send", id: this.id, seq, message });
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.closed || this.pid === undefined || this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.post({ type: "kill", id: this.id, signal });
    return true;
  }

  disconnect(): void {
    if (this.connected) this.post({ type: "disconnect", id: this.id });
  }

  ref(): void {
    this.worker.ref();
  }

  unref(): void {
    this.worker.unref();
  }

  /** Applies one relayed event. Returns true once the child has fully closed. */
  handle(event: HostEvent): boolean {
    switch (event.type) {
      case "stdout":
      case "stderr": {
        const { chunk } = event;
        this[event.type]?.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        return false;
      }
      case "message":
        this.emit("message", event.message);
        return false;
      case "sent": {
        const callback = this.sendCallbacks.get(event.seq);
        this.sendCallbacks.delete(event.seq);
        const error = event.error ? toError(event.error) : null;
        if (callback) callback(error);
        else if (error) this.report(error);
        return false;
      }
      case "disconnect":
        this.connected = false;
        this.emit("disconnect");
        return false;
      case "error":
        this.report(toError(event.error));
        return false;
      case "exit":
        this.exitCode = event.code;
        this.signalCode = event.signal;
        this.connected = false;
        this.emit("exit", event.code, event.signal);
        return false;
      case "close":
        this.finish(event.code, event.signal);
        return true;
      default:
        return false;
    }
  }

  /**
   * The process could not be created. Like a real ChildProcess, the handle reports it through
   * "error" followed by "close" instead of a rejected spawn call.
   */
  failToSpawn(error: Error): void {
    setImmediate(() => {
      this.report(error);
      this.finish(null, null);
    });
  }

  /** The worker thread died: the child can no longer be observed or controlled. */
  lose(reason: Error): void {
    if (this.closed) return;
    this.report(reason);
    try {
      if (this.pid !== undefined) process.kill(this.pid);
    } catch {
      // Already gone.
    }
    if (this.exitCode === null && this.signalCode === null) this.emit("exit", null, null);
    this.finish(null, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    for (const callback of this.sendCallbacks.values()) callback(new Error("Child process closed before the message was sent"));
    this.sendCallbacks.clear();
    this.stdout?.end();
    this.stderr?.end();
    // Buffered output is delivered before "close", as it is for a real ChildProcess.
    setImmediate(() => this.emit("close", code, signal));
  }
}

interface PoolWorker {
  worker: HostWorker;
  /** Requests whose process has not been created yet: the worker thread may be blocked. */
  creating: number;
  active: Set<number>;
}

interface PendingExec {
  id: number;
  request: HostExecRequest;
  file: string;
  enqueuedAt: number;
  dispatchedAt?: number;
  owner?: PoolWorker;
  deadline?: NodeJS.Timeout;
  resolve: (value: { stdout: string; stderr: string }) => void;
  reject: (error: Error) => void;
}

export class ProcessHost {
  readonly mode: ProcessHostMode;
  private readonly maxPoolWorkers: number;
  private readonly onLaunch?: (observation: ProcessLaunchObservation) => void;
  private readonly createWorker: () => HostWorker;
  private readonly pool: PoolWorker[] = [];
  private readonly dedicated = new Set<HostWorker>();
  private readonly queue: PendingExec[] = [];
  private readonly execs = new Map<number, PendingExec>();
  private nextId = 0;
  private closed = false;

  constructor(options: ProcessHostOptions = {}) {
    this.mode = options.mode ?? "worker";
    this.maxPoolWorkers = Math.max(1, options.maxPoolWorkers ?? DEFAULT_MAX_POOL_WORKERS);
    this.onLaunch = options.onLaunch;
    this.createWorker = options.createWorker ?? startWorkerThread;
  }

  /** Like util.promisify(child_process.execFile): resolves with output, rejects with HostExecError. */
  execFile(file: string, args: readonly string[] = [], options: HostExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
    return this.runExec({ kind: "execFile", file, args: [...args], options: cloneableExecOptions(options) }, file);
  }

  /** Like util.promisify(child_process.exec): runs a command line through the shell. */
  exec(command: string, options: HostExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
    return this.runExec({ kind: "exec", command, options: cloneableExecOptions(options) }, command);
  }

  /**
   * Like child_process.spawn, but asynchronous: resolves once the process exists. A process that
   * cannot be created still resolves, with `pid` undefined and an "error" event, as spawn does.
   */
  spawn(file: string, args: readonly string[] = [], options: SpawnOptions = {}): Promise<HostChild> {
    return this.start("spawn", file, args, options);
  }

  /** Like child_process.fork, but asynchronous: resolves once the process exists. */
  fork(modulePath: string, args: readonly string[] = [], options: ForkOptions = {}): Promise<HostChild> {
    return this.start("fork", modulePath, args, options);
  }

  /** Deletes a file or directory tree. A path that is already gone is not an error. */
  async removeTree(path: string): Promise<void> {
    if (this.closed) throw new Error("Process host shut down");
    if (!lstatSync(path, { throwIfNoEntry: false })) return;
    if (this.mode === "inline") {
      (await import("./process-host-worker.js")).removeTreeOnCallingThread(path);
      return;
    }
    const worker = this.createWorker();
    this.dedicated.add(worker);
    try {
      const event = await new Promise<HostEvent>((resolve, reject) => {
        worker.on("message", resolve);
        worker.on("error", reject);
        worker.on("exit", (code) => reject(new Error(`Process host worker exited with code ${code}`)));
        worker.postMessage({ type: "remove-tree", id: ++this.nextId, path } satisfies HostRequest);
      });
      if (event.type === "tree-removed" && event.error) throw toError(event.error);
    } finally {
      this.dedicated.delete(worker);
      void worker.terminate();
    }
  }

  /** Stops every worker thread. Children of terminated workers are not waited for. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const failure = new Error("Process host shut down");
    for (const pending of [...this.execs.values()]) this.settleExec(pending, failure);
    const workers = [...this.pool.map((entry) => entry.worker), ...this.dedicated];
    this.pool.length = 0;
    this.dedicated.clear();
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }

  private async runExec(request: HostExecRequest, file: string): Promise<{ stdout: string; stderr: string }> {
    if (this.closed) throw new Error("Process host shut down");
    if (this.mode === "inline") {
      const { execToOutcome } = await import("./process-host-worker.js");
      return outcomeToResult(await execToOutcome(request));
    }
    request.options.env ??= liveEnv();
    return new Promise((resolve, reject) => {
      const pending: PendingExec = { id: ++this.nextId, request, file, enqueuedAt: performance.now(), resolve, reject };
      const timeout = request.options.timeout;
      if (typeof timeout === "number" && timeout > 0) {
        pending.deadline = setTimeout(() => this.expireExec(pending, timeout), timeout + DEADLINE_GRACE_MS);
        pending.deadline.unref();
      }
      this.execs.set(pending.id, pending);
      this.queue.push(pending);
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const target = this.pickPoolWorker();
      if (!target) return;
      const pending = this.queue.shift()!;
      pending.owner = target;
      pending.dispatchedAt = performance.now();
      if (target.active.size === 0) target.worker.ref();
      target.creating += 1;
      target.active.add(pending.id);
      target.worker.postMessage({ type: "exec", id: pending.id, request: pending.request } satisfies HostRequest);
    }
  }

  /** A worker that is still creating a process may be blocked, so it is never given another. */
  private pickPoolWorker(): PoolWorker | undefined {
    let best: PoolWorker | undefined;
    for (const candidate of this.pool) {
      if (candidate.creating > 0) continue;
      if (!best || candidate.active.size < best.active.size) best = candidate;
    }
    if (best || this.pool.length >= this.maxPoolWorkers) return best;
    return this.addPoolWorker();
  }

  private addPoolWorker(): PoolWorker {
    const worker = this.createWorker();
    const entryRecord: PoolWorker = { worker, creating: 0, active: new Set() };
    worker.unref();
    worker.on("message", (event: HostEvent) => this.handlePoolEvent(entryRecord, event));
    worker.on("error", (error) => this.losePoolWorker(entryRecord, error));
    worker.on("exit", (code) => this.losePoolWorker(entryRecord, new Error(`Process host worker exited with code ${code}`)));
    this.pool.push(entryRecord);
    return entryRecord;
  }

  private handlePoolEvent(owner: PoolWorker, event: HostEvent): void {
    if (event.type === "exec-created") {
      owner.creating = Math.max(0, owner.creating - 1);
      const pending = this.execs.get(event.id);
      if (pending) this.observe("exec", pending.file, event.createMs, (pending.dispatchedAt ?? pending.enqueuedAt) - pending.enqueuedAt);
      this.dispatch();
      return;
    }
    if (event.type !== "exec-done") return;
    this.releaseFromWorker(owner, event.id);
    const pending = this.execs.get(event.id);
    if (pending) this.settleExec(pending, undefined, event.outcome);
    this.dispatch();
  }

  private releaseFromWorker(owner: PoolWorker, id: number): void {
    if (owner.active.delete(id) && owner.active.size === 0) owner.worker.unref();
  }

  private losePoolWorker(owner: PoolWorker, reason: Error): void {
    const index = this.pool.indexOf(owner);
    if (index < 0) return;
    this.pool.splice(index, 1);
    for (const id of owner.active) {
      const pending = this.execs.get(id);
      if (pending) this.settleExec(pending, new Error(`Process host worker failed: ${reason.message}`));
    }
    owner.active.clear();
    if (!this.closed) this.dispatch();
  }

  private expireExec(pending: PendingExec, timeout: number): void {
    if (!this.execs.has(pending.id)) return;
    const queuedIndex = this.queue.indexOf(pending);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    else pending.owner?.worker.postMessage({ type: "cancel", id: pending.id } satisfies HostRequest);
    const stage = queuedIndex >= 0 ? "waiting for a free process-host worker" : "creating or running the process";
    this.settleExec(pending, new HostExecError({
      message: `Command timed out after ${timeout}ms while ${stage}: ${pending.file}`,
      code: null,
      killed: true,
      signal: "SIGTERM",
      cmd: pending.file,
    }, "", "", true));
  }

  private settleExec(pending: PendingExec, failure?: Error, outcome?: HostExecOutcome): void {
    if (!this.execs.delete(pending.id)) return;
    if (pending.deadline) clearTimeout(pending.deadline);
    if (failure) {
      pending.reject(failure);
      return;
    }
    try {
      pending.resolve(outcomeToResult(outcome!));
    } catch (error) {
      pending.reject(error as Error);
    }
  }

  private async start(
    mode: "spawn" | "fork",
    file: string,
    args: readonly string[],
    options: SpawnOptions | ForkOptions,
  ): Promise<HostChild> {
    if (this.closed) throw new Error("Process host shut down");
    if (this.mode === "inline") {
      const inline = await import("./process-host-worker.js");
      return mode === "fork"
        ? inline.forkOnCallingThread(file, args, options as ForkOptions)
        : inline.spawnOnCallingThread(file, args, options as SpawnOptions);
    }

    const hostOptions = toHostSpawnOptions(options, mode);
    const worker = this.createWorker();
    const id = ++this.nextId;
    const requestedAt = performance.now();
    this.dedicated.add(worker);

    return new Promise<HostChild>((resolve, reject) => {
      let child: HostedChildProcess | undefined;
      const release = (): void => {
        this.dedicated.delete(worker);
        void worker.terminate();
      };
      const lose = (reason: Error): void => {
        if (!this.dedicated.has(worker)) return;
        this.dedicated.delete(worker);
        if (child) child.lose(reason);
        else reject(reason);
      };

      worker.on("message", (event: HostEvent) => {
        if (!child) {
          if (event.type === "spawned") {
            this.observe(mode, file, event.createMs, 0);
            child = new HostedChildProcess(event.pid, id, worker, hostOptions);
            resolve(child);
          } else if (event.type === "error") {
            if (event.createMs !== undefined) this.observe(mode, file, event.createMs, performance.now() - requestedAt - event.createMs);
            release();
            const failed = new HostedChildProcess(undefined, id, worker, hostOptions);
            failed.failToSpawn(toError(event.error));
            resolve(failed);
          }
          return;
        }
        if (child.handle(event)) release();
      });
      worker.on("error", (error) => lose(error));
      worker.on("exit", (code) => lose(new Error(`Process host worker exited with code ${code}`)));
      worker.postMessage({ type: "spawn", id, file, args: [...args], options: hostOptions } satisfies HostRequest);
    });
  }

  private observe(kind: ProcessLaunchObservation["kind"], file: string, createMs: number, queuedMs: number): void {
    try {
      this.onLaunch?.({ kind, file, createMs, queuedMs: Math.max(0, queuedMs) });
    } catch {
      // Observers are diagnostics: they must never affect a launch.
    }
  }
}

/**
 * A worker thread holds a copy of process.env taken when the thread started, and pool workers
 * live for the life of the server. child_process reads the live process.env when `env` is
 * omitted, so the host resolves it on the calling thread, at call time, to keep that behaviour.
 */
function liveEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function cloneableExecOptions(options: HostExecOptions): HostExecOptions {
  return { ...options, ...(options.env ? { env: { ...options.env } } : {}) };
}

function outcomeToResult(outcome: HostExecOutcome): { stdout: string; stderr: string } {
  if (outcome.error) throw new HostExecError(outcome.error, outcome.stdout, outcome.stderr);
  return { stdout: outcome.stdout, stderr: outcome.stderr };
}

let defaultHost: ProcessHost | undefined;
let launchObserver: ((observation: ProcessLaunchObservation) => void) | undefined;

function resolveDefaultMode(): ProcessHostMode {
  const configured = process.env.BRIDGE_PROCESS_HOST;
  if (configured === "inline" || configured === "worker") return configured;
  // Test suites mock node:child_process on their own thread, which a worker thread cannot see.
  return process.env.NODE_ENV === "test" ? "inline" : "worker";
}

/** The process-wide host. Created on first use so importing this module starts no threads. */
export function getProcessHost(): ProcessHost {
  return (defaultHost ??= new ProcessHost({
    mode: resolveDefaultMode(),
    onLaunch: (observation) => launchObserver?.(observation),
  }));
}

export function setProcessLaunchObserver(observer: ((observation: ProcessLaunchObservation) => void) | undefined): void {
  launchObserver = observer;
}

/** Test hook: drops the process-wide host so the next use re-reads the environment. */
export async function resetProcessHostForTests(): Promise<void> {
  const host = defaultHost;
  defaultHost = undefined;
  await host?.shutdown();
}
