import "./server/load-bridge-env.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type DatabaseSync } from "./server/db.js";
import { resolveRuntimePaths } from "./server/runtime-paths.js";
import {
  RESTART_STATE_FILE_NAME,
  isRestartPending,
  sweepStaleRestartStateTempFiles,
} from "./server/restart-state.js";
import {
  createManagementJobStore,
  DEFAULT_MANAGEMENT_JOB_STALE_AFTER_MS,
  getManagementJobStaleAfterMs,
  type ManagementJob,
  type ManagementJobStore,
} from "./server/management-job-store.js";
import {
  dispatchManagementJob,
  ManagementJobExecutionError,
  type ManagementJobDispatchOptions,
} from "./server/management-job-dispatch.js";
import { readActiveRelease } from "./server/release-slots.js";
import { cleanupCompletedStagingDeploy } from "./server/staging-tools.js";
import { getProcessHost } from "./server/process-host.js";
import { resolveBridgeControlRoot } from "./server/control-root.js";
import { withNonInteractiveCommandEnv } from "./server/noninteractive-env.js";
import { isRecord } from "./shared/is-record.js";
import {
  DEPLOY_RESTART_SOURCE,
  requestRestart,
  type RestartReleaseCandidate,
} from "./server/restart-signal.js";

export interface ManagementJobRunnerOptions {
  store: ManagementJobStore;
  dispatch?: (job: ManagementJob, options: ManagementJobDispatchOptions) => Promise<unknown>;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  shouldStop?: () => boolean;
  /**
   * Where the restart for finished deploys is requested. The runner asks once for all of them and
   * follows them until their release is active. Unset, each deploy job asks for its own restart.
   */
  deployBatchDataDir?: string;
  requestDeployRestart?: (dataDir: string, candidate: RestartReleaseCandidate) => void | Promise<void>;
  isRestartPending?: (dataDir: string) => boolean;
  getActiveRelease?: (dataDir: string) => RestartReleaseCandidate | null;
  isCommitIncluded?: (commitSha: string, activeSha: string) => Promise<boolean>;
  cleanupDeploy?: (stagingDir: string) => Promise<void>;
  log?: (message: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = DEFAULT_MANAGEMENT_JOB_STALE_AFTER_MS;
interface ClaimedJobResult {
  succeeded: boolean;
  result?: unknown;
}

interface PendingDeploy {
  job: ManagementJob;
  result: Record<string, unknown>;
  candidate: RestartReleaseCandidate;
}

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

/** Keeps management job rows and their logs bounded in long-lived runner processes. */
async function pruneManagementJobArtifacts(
  store: ManagementJobStore,
  log: (message: string) => void,
): Promise<void> {
  try {
    const result = await store.pruneRetention();
    if (result.deletedJobIds.length > 0 || result.deletedLogPaths.length > 0) {
      log(
        `Pruned ${result.deletedJobIds.length} old job row(s) `
        + `and ${result.deletedLogPaths.length} log file(s)`,
      );
    }
  } catch (error) {
    log(`Retention prune failed: ${formatError(error)}`);
  }
}

export async function runClaimedManagementJob(
  store: ManagementJobStore,
  job: ManagementJob,
  options: Omit<ManagementJobRunnerOptions, "store"> = {},
): Promise<ClaimedJobResult> {
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
    const result = await dispatch(job, {
      log: jobLog,
      deferDeployRestart: options.deployBatchDataDir !== undefined && job.type === "staging_deploy",
    });
    store.succeed(job.id, result);
    jobLog(`Succeeded ${job.type} job`);
    return { succeeded: true, result };
  } catch (error) {
    const message = error instanceof ManagementJobExecutionError
      ? error.message
      : formatError(error);
    const result = error instanceof ManagementJobExecutionError ? error.result : undefined;
    store.fail(job.id, message, result);
    jobLog(`Failed ${job.type} job: ${message}`);
    return { succeeded: false, result };
  } finally {
    clearInterval(heartbeat);
  }
}

function pendingDeploy(job: ManagementJob): PendingDeploy | null {
  if (job.type !== "staging_deploy" || job.status !== "succeeded" || !isRecord(job.result)) return null;
  const candidate = job.result.releaseCandidate;
  if (!isRecord(candidate)) return null;
  const fields = ["id", "root", "commitSha", "source", "dependencyHash"] as const;
  if (!fields.every((field) => typeof candidate[field] === "string" && candidate[field].trim())) return null;
  if (
    job.result.restartDeferred !== true
    && !(job.result.restartQueued === true && job.result.restartActivated !== true)
  ) return null;
  return {
    job,
    result: job.result,
    candidate: candidate as unknown as RestartReleaseCandidate,
  };
}

function listPendingDeploys(store: ManagementJobStore): PendingDeploy[] {
  return store.listDeploysAwaitingActivation().map(pendingDeploy)
    .filter((entry): entry is PendingDeploy => entry !== null);
}

function activeRelease(options: ManagementJobRunnerOptions, dataDir: string): RestartReleaseCandidate | null {
  return options.getActiveRelease ? options.getActiveRelease(dataDir) : readActiveRelease(dataDir);
}

async function isCommitIncluded(commitSha: string, activeSha: string): Promise<boolean> {
  try {
    await getProcessHost().execFile("git", ["merge-base", "--is-ancestor", commitSha, activeSha], {
      cwd: resolveBridgeControlRoot(join(dirname(fileURLToPath(import.meta.url)), "..")),
      timeout: 30_000,
      env: withNonInteractiveCommandEnv(process.env),
    });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
    throw error;
  }
}

function cancelQueuedDeploys(store: ManagementJobStore, reason: string): void {
  for (const queued of store.listActive(["staging_deploy"])) {
    if (queued.status === "queued") store.cancel(queued.id, reason);
  }
}

async function reconcileDeploys(
  store: ManagementJobStore,
  dataDir: string,
  log: (message: string) => void,
  options: ManagementJobRunnerOptions,
): Promise<void> {
  const pending = listPendingDeploys(store);
  if (pending.length === 0) return;
  const latest = pending[pending.length - 1];
  const active = activeRelease(options, dataDir);

  let activated = active?.commitSha === latest.candidate.commitSha;
  if (!activated && active && latest.result.restartQueued === true
    && !(options.isRestartPending ?? isRestartPending)(dataDir)) {
    try {
      // A self-update can supersede the deploy candidate while still containing every merged deploy.
      activated = await (options.isCommitIncluded ?? isCommitIncluded)(latest.candidate.commitSha, active.commitSha);
    } catch (error) {
      const message = `Deployment activation could not be verified: ${formatError(error)}`;
      log(message);
      for (const entry of pending) store.fail(entry.job.id, message, entry.result);
      return;
    }
  }
  if (activated) {
    for (const entry of pending) {
      let cleanupWarning: string | undefined;
      if (isRecord(entry.job.input) && typeof entry.job.input.stagingDir === "string") {
        try {
          await (options.cleanupDeploy ?? cleanupCompletedStagingDeploy)(entry.job.input.stagingDir);
        } catch (error) {
          cleanupWarning = `Post-activation cleanup failed: ${formatError(error)}`;
        }
      }
      store.succeed(entry.job.id, {
        ...entry.result,
        restartDeferred: false,
        restartQueued: true,
        restartActivated: true,
        ...(cleanupWarning ? { cleanupWarning } : {}),
      });
    }
    log(`Confirmed activation for ${pending.length} batched deploy(s)`);
    return;
  }

  if (latest.result.restartQueued === true) {
    // The restart waits for the Bridge to go idle for as long as that takes; only its end is a verdict.
    if ((options.isRestartPending ?? isRestartPending)(dataDir)) return;
    const message = "The restart for this deploy did not activate its release.";
    for (const entry of pending) store.fail(entry.job.id, message, entry.result);
    cancelQueuedDeploys(store, `${message} Requeue after recovery.`);
    return;
  }

  // Asking joins whatever restart is already pending, and the newest release is the one it activates.
  try {
    if (options.requestDeployRestart) {
      await options.requestDeployRestart(dataDir, latest.candidate);
    } else {
      await requestRestart(dataDir, {
        validationMode: "deploy",
        source: DEPLOY_RESTART_SOURCE,
        releaseCandidate: latest.candidate,
      });
    }
  } catch (error) {
    const message = `The restart for this deploy could not be requested: ${formatError(error)}`;
    for (const entry of pending) store.fail(entry.job.id, message, entry.result);
    cancelQueuedDeploys(store, `${message} Requeue after recovery.`);
    return;
  }
  for (const entry of pending) {
    store.succeed(entry.job.id, {
      ...entry.result,
      restartDeferred: false,
      restartQueued: true,
      restartActivated: false,
      deployBatchSize: pending.length,
    });
  }
  log(`Requested one restart for ${pending.length} finished deploy(s)`);
}

export async function runManagementJobRunnerLoop(options: ManagementJobRunnerOptions): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const log = options.log ?? runnerLog;
  const dataDir = options.deployBatchDataDir;

  log(`Runner PID ${process.pid} started`);
  // Jobs run whenever there are jobs. A pending restart holds none of them back: it waits for them.
  while (!options.shouldStop?.()) {
    const job = options.store.claimNext({ runnerPid: process.pid, staleAfterMs });
    if (job) {
      const outcome = await runClaimedManagementJob(options.store, job, options);
      if (job.type === "staging_deploy" && !outcome.succeeded) {
        cancelQueuedDeploys(options.store, "Cancelled after an earlier deploy failed.");
      }
    }
    if (dataDir) await reconcileDeploys(options.store, dataDir, log, options);
    if (job) await pruneManagementJobArtifacts(options.store, log);
    else await wait(pollIntervalMs);
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
  const sweptTemps = sweepStaleRestartStateTempFiles(
    resolve(runtimePaths.dataDir, RESTART_STATE_FILE_NAME),
  );
  if (sweptTemps > 0) {
    runnerLog(`Swept ${sweptTemps} stale restart-state temp file(s) at startup`);
  }
  let stopping = false;
  const initialReleaseId = readActiveRelease(runtimePaths.dataDir)?.id;
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
      // Refresh the runner's code between jobs after activation, never by killing a job in flight.
      shouldStop: () => stopping || readActiveRelease(runtimePaths.dataDir)?.id !== initialReleaseId,
      deployBatchDataDir: runtimePaths.dataDir,
      pollIntervalMs: Number(process.env.BRIDGE_MANAGEMENT_JOB_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
      heartbeatIntervalMs: Number(process.env.BRIDGE_MANAGEMENT_JOB_HEARTBEAT_INTERVAL_MS) || DEFAULT_HEARTBEAT_INTERVAL_MS,
      staleAfterMs: getManagementJobStaleAfterMs(process.env),
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
