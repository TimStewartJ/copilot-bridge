import "./server/load-bridge-env.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type DatabaseSync } from "./server/db.js";
import { resolveRuntimePaths } from "./server/runtime-paths.js";
import {
  createManagementJobStore,
  type ManagementJob,
  type ManagementJobStore,
} from "./server/management-job-store.js";
import {
  dispatchManagementJob,
  ManagementJobExecutionError,
  type ManagementJobDispatchOptions,
} from "./server/management-job-dispatch.js";

export interface ManagementJobRunnerOptions {
  store: ManagementJobStore;
  dispatch?: (job: ManagementJob, options: ManagementJobDispatchOptions) => Promise<unknown>;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  shouldStop?: () => boolean;
  log?: (message: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

function runnerLog(message: string): void {
  console.log(`[management-job-runner] ${message}`);
}

function appendJobLog(job: ManagementJob, message: string): void {
  if (!job.logPath) return;
  mkdirSync(dirname(job.logPath), { recursive: true });
  appendFileSync(job.logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
}

function createJobLogger(job: ManagementJob, log: (message: string) => void): (message: string) => void {
  return (message) => {
    appendJobLog(job, message);
    log(`[${job.id}] ${message}`);
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });
}

export async function runClaimedManagementJob(
  store: ManagementJobStore,
  job: ManagementJob,
  options: Omit<ManagementJobRunnerOptions, "store"> = {},
): Promise<void> {
  const log = options.log ?? runnerLog;
  const jobLog = createJobLogger(job, log);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const dispatch = options.dispatch ?? dispatchManagementJob;

  jobLog(`Starting ${job.type} job in PID ${process.pid}`);
  const heartbeat = setInterval(() => {
    try {
      store.heartbeat(job.id, process.pid);
    } catch (error) {
      jobLog(`Heartbeat failed: ${formatError(error)}`);
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    const result = await dispatch(job, { log: jobLog });
    store.succeed(job.id, result);
    jobLog(`Succeeded ${job.type} job`);
  } catch (error) {
    const message = error instanceof ManagementJobExecutionError
      ? error.message
      : formatError(error);
    const result = error instanceof ManagementJobExecutionError ? error.result : undefined;
    store.fail(job.id, message, result);
    jobLog(`Failed ${job.type} job: ${message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runManagementJobRunnerLoop(options: ManagementJobRunnerOptions): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const log = options.log ?? runnerLog;

  log(`Runner PID ${process.pid} started`);
  while (!options.shouldStop?.()) {
    const job = options.store.claimNext({ runnerPid: process.pid, staleAfterMs });
    if (!job) {
      await wait(pollIntervalMs);
      continue;
    }
    await runClaimedManagementJob(options.store, job, options);
  }
  log("Runner stopping");
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main(): Promise<void> {
  const runtimePaths = resolveRuntimePaths(process.env);
  Object.assign(process.env, runtimePaths.env);
  let stopping = false;
  let db: DatabaseSync | null = openDatabase(runtimePaths.dataDir);
  const store = createManagementJobStore(db, { dataDir: runtimePaths.dataDir });

  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  try {
    await runManagementJobRunnerLoop({
      store,
      shouldStop: () => stopping,
      pollIntervalMs: Number(process.env.BRIDGE_MANAGEMENT_JOB_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
      heartbeatIntervalMs: Number(process.env.BRIDGE_MANAGEMENT_JOB_HEARTBEAT_INTERVAL_MS) || DEFAULT_HEARTBEAT_INTERVAL_MS,
      staleAfterMs: Number(process.env.BRIDGE_MANAGEMENT_JOB_STALE_AFTER_MS) || DEFAULT_STALE_AFTER_MS,
    });
  } finally {
    db?.close();
    db = null;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[management-job-runner] Fatal: ${formatError(error)}`);
    process.exitCode = 1;
  });
}
