// Shared contract of the process host: request/response shapes that cross the thread boundary,
// and the error type callers see. This module must stay free of node:child_process so the
// server's main thread never loads it through the host.

export interface HostExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Milliseconds the command may take. The worker applies it to the running process, and the
   * host also enforces it on the calling thread so slow process creation cannot exceed it.
   */
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  killSignal?: NodeJS.Signals | number;
  encoding?: "utf-8" | "utf8";
  /**
   * "stdout-json" completes as soon as stdout holds one complete JSON value and then kills the
   * child. Some CLI clients print their result but do not exit promptly.
   */
  completeWhen?: "stdout-json";
}

export type HostExecRequest =
  | { kind: "execFile"; file: string; args: string[]; options: HostExecOptions }
  | { kind: "exec"; command: string; options: HostExecOptions };

export interface SerializedExecError {
  message: string;
  name?: string;
  /** Exit code, or an errno string such as "ENOENT" or "ERR_CHILD_PROCESS_STDIO_MAXBUFFER". */
  code?: number | string | null;
  errno?: number;
  syscall?: string;
  path?: string;
  spawnargs?: string[];
  cmd?: string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

export interface HostExecOutcome {
  stdout: string;
  stderr: string;
  error?: SerializedExecError;
  /** Duration of the synchronous process-creation call on the thread that ran it. */
  createMs: number;
}

/** Mirrors the error Node's execFile rejects with, so existing error handling keeps working. */
export class HostExecError extends Error {
  code: number | string | null;
  errno?: number;
  syscall?: string;
  path?: string;
  spawnargs?: string[];
  cmd?: string;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the host gave up on the calling thread because the deadline passed. */
  timedOut: boolean;

  constructor(error: SerializedExecError, stdout: string, stderr: string, timedOut = false) {
    super(error.message);
    this.name = error.name ?? "Error";
    this.code = error.code ?? null;
    this.errno = error.errno;
    this.syscall = error.syscall;
    this.path = error.path;
    this.spawnargs = error.spawnargs;
    this.cmd = error.cmd;
    this.killed = error.killed === true;
    this.signal = error.signal ?? null;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

export type HostStdio = "pipe" | "ignore";

/** The subset of child_process spawn/fork options that can cross a thread boundary. */
export interface HostSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  shell?: boolean | string;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  detached?: boolean;
  stdin: HostStdio;
  stdout: HostStdio;
  stderr: HostStdio;
  ipc: boolean;
  serialization?: "json" | "advanced";
  /** "fork" runs `file` as a Node module entry, like child_process.fork. */
  mode: "spawn" | "fork";
  execArgv?: string[];
}

export interface SerializedHostError {
  message: string;
  name?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
  spawnargs?: string[];
}

export type HostRequest =
  | { type: "exec"; id: number; request: HostExecRequest }
  | { type: "cancel"; id: number }
  | { type: "spawn"; id: number; file: string; args: string[]; options: HostSpawnOptions }
  | { type: "stdin"; id: number; chunk: Uint8Array | null }
  | { type: "send"; id: number; seq: number; message: unknown }
  | { type: "kill"; id: number; signal?: NodeJS.Signals | number }
  | { type: "disconnect"; id: number };

/** `createMs` is how long the synchronous process-creation call took on the worker thread. */
export type HostEvent =
  | { type: "exec-created"; id: number; createMs: number }
  | { type: "exec-done"; id: number; outcome: HostExecOutcome }
  | { type: "spawned"; id: number; pid: number; createMs: number }
  | { type: "error"; id: number; error: SerializedHostError; createMs?: number }
  | { type: "stdout" | "stderr"; id: number; chunk: Uint8Array }
  | { type: "message"; id: number; message: unknown }
  | { type: "sent"; id: number; seq: number; error?: SerializedHostError }
  | { type: "disconnect"; id: number }
  | { type: "exit"; id: number; code: number | null; signal: NodeJS.Signals | null }
  | { type: "close"; id: number; code: number | null; signal: NodeJS.Signals | null };
