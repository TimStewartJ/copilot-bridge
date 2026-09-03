import "./server/load-bridge-env.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type DatabaseSync } from "./server/db.js";
import { resolveRuntimePaths } from "./server/runtime-paths.js";
import {
  RESTART_IN_PROGRESS_FILE_NAME,
  RESTART_STATE_FILE_NAME,
  RESTART_SIGNAL_FILE_NAME,
  isDeployBatchRestartUpdateWindowOpen,
  isRestartAlreadyInFlight,
  sweepStaleRestartStateTempFiles,
} from "./server/restart-state.js";
import {
  createManagementJobStore,
  DEFAULT_MANAGEMENT_JOB_STALE_AFTER_MS,
  getManagementJobStaleAfterMs,
  MANAGEMENT_DEPLOY_BATCH_MAX_JOBS,
  type ManagementJob,
  type ManagementJobStore,
} from "./server/management-job-store.js";
export { MANAGEMENT_DEPLOY_BATCH_MAX_JOBS } from "./server/management-job-store.js";
import {
  dispatchManagementJob,
  ManagementJobExecutionError,
  type ManagementJobDispatchOptions,
} from "./server/management-job-dispatch.js";
import { readActiveRelease } from "./server/release-slots.js";
import { writeRestartSignalOrRollback } from "./server/restart-inflight.js";
import { cleanupCompletedStagingDeploy } from "./server/staging-tools.js";
import { isRecord } from "./shared/is-record.js";
import {
  DEPLOY_BATCH_RESTART_SOURCE,
  publishDeployBatchRestartUpdate,
  type RestartReleaseCandidate,
} from "./server/restart-signal.js";

export interface ManagementJobRunnerOptions {
  store: ManagementJobStore;
  dispatch?: (job: ManagementJob, options: ManagementJobDispatchOptions) => Promise<unknown>;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  shouldStop?: () => boolean;
  getHoldReason?: () => string | null;
  deployBatchDataDir?: string;
  queueDeployRestart?: (dataDir: string, candidate: RestartReleaseCandidate) => void;
  retargetDeployRestart?: (dataDir: string, candidate: RestartReleaseCandidate) => void;
  getActiveRelease?: (dataDir: string) => RestartReleaseCandidate | null;
  cleanupDeploy?: (stagingDir: string) => Promise<void>;
  /**
   * Checked after each job completes. When it returns true the loop exits so the
   * launcher can respawn the runner on fresh code. Used to step aside once a
   * deploy/update job has queued a restart, instead of relying on the launcher's
   * cycleManagementJobRunner (which it skips when a job is still running).
   */
  shouldStopAfterJob?: (job: ManagementJob) => boolean;
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

/**
 * Keeps management job rows and their logs bounded in long-lived runner
 * processes. Skipped when the loop is stepping aside for a restart so retention
 * never delays a deploy cutover — the restarted server sweeps at startup.
 */
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
  return store.list({
    types: ["staging_deploy"],
    statuses: ["succeeded"],
    order: "created-asc",
    limit: 200,
  }).map(pendingDeploy).filter((entry): entry is PendingDeploy => entry !== null);
}

function activeRelease(options: ManagementJobRunnerOptions, dataDir: string): RestartReleaseCandidate | null {
  return options.getActiveRelease ? options.getActiveRelease(dataDir) : readActiveRelease(dataDir);
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

  if (active?.id === latest.candidate.id && active.commitSha === latest.candidate.commitSha) {
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
    if (isRestartAlreadyInFlight(dataDir)) return;
    const message = "The shared deploy restart did not activate the expected release.";
    for (const entry of pending) store.fail(entry.job.id, message, entry.result);
    cancelQueuedDeploys(store, `${message} Requeue after recovery.`);
    return;
  }

  const retargeting = pending.some((entry) => entry.result.restartQueued === true);
  try {
    if (retargeting && options.retargetDeployRestart) {
      options.retargetDeployRestart(dataDir, latest.candidate);
    } else if (retargeting) {
      publishDeployBatchRestartUpdate(
        join(dataDir, RESTART_SIGNAL_FILE_NAME),
        join(dataDir, RESTART_IN_PROGRESS_FILE_NAME),
        latest.candidate,
      );
    } else if (options.queueDeployRestart) {
      options.queueDeployRestart(dataDir, latest.candidate);
    } else {
      writeRestartSignalOrRollback(
        join(dataDir, RESTART_SIGNAL_FILE_NAME),
        "deploy",
        DEPLOY_BATCH_RESTART_SOURCE,
        latest.candidate,
      );
    }
  } catch (error) {
    const action = retargeting ? "updated" : "queued";
    const message = `Shared deploy restart could not be ${action}: ${formatError(error)}`;
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
  log(
    retargeting
      ? `Updated the pending restart to the newest of ${pending.length} batched deploy(s)`
      : `Queued one restart for ${pending.length} batched deploy(s)`,
  );
}

async function runDeployBatch(
  options: ManagementJobRunnerOptions,
  firstJob?: ManagementJob,
): Promise<void> {
  const dataDir = options.deployBatchDataDir;
  if (!dataDir) return;
  let attempted = listPendingDeploys(options.store).length;
  let job = firstJob;
  while (attempted < MANAGEMENT_DEPLOY_BATCH_MAX_JOBS) {
    job ??= options.store.claimNextDeploy({
      runnerPid: process.pid,
      staleAfterMs: options.staleAfterMs,
    }) ?? undefined;
    if (!job) break;
    attempted++;
    const outcome = await runClaimedManagementJob(options.store, job, options);
    job = undefined;
    if (!outcome.succeeded) {
      cancelQueuedDeploys(options.store, "Cancelled after an earlier deploy failed.");
      break;
    }
  }
  await reconcileDeploys(options.store, dataDir, options.log ?? runnerLog, options);
}

export async function runManagementJobRunnerLoop(options: ManagementJobRunnerOptions): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const log = options.log ?? runnerLog;
  let holdReason: string | null = null;

  log(`Runner PID ${process.pid} started`);
  while (!options.shouldStop?.()) {
    const nextHold = options.getHoldReason?.() ?? null;
    if (nextHold) {
      if (nextHold !== holdReason) log(`Holding queued jobs: ${nextHold}`);
      holdReason = nextHold;
      const previewJob = options.store.claimNext({
        runnerPid: process.pid,
        staleAfterMs,
        types: ["staging_preview"],
      });
      if (previewJob) {
        await runClaimedManagementJob(options.store, previewJob, options);
        await pruneManagementJobArtifacts(options.store, log);
        continue;
      }
      await wait(pollIntervalMs);
      continue;
    }
    holdReason = null;
    const pending = options.deployBatchDataDir ? listPendingDeploys(options.store) : [];
    if (options.deployBatchDataDir && pending.length > 0) {
      await runDeployBatch(options);
      await pruneManagementJobArtifacts(options.store, log);
      continue;
    }
    const job = options.store.claimNext({ runnerPid: process.pid, staleAfterMs });
    if (!job) {
      await wait(pollIntervalMs);
      continue;
    }
    if (job.type === "staging_deploy" && options.deployBatchDataDir) {
      await runDeployBatch(options, job);
      await pruneManagementJobArtifacts(options.store, log);
      continue;
    }
    await runClaimedManagementJob(options.store, job, options);
    if (options.shouldStopAfterJob?.(job)) {
      log(`Stopping after ${job.type} job so the launcher can respawn the runner on fresh code`);
      break;
    }
    await pruneManagementJobArtifacts(options.store, log);
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
      getHoldReason: () => {
        if (!isRestartAlreadyInFlight(runtimePaths.dataDir)) return null;
        return isDeployBatchRestartUpdateWindowOpen(runtimePaths.dataDir)
          ? null
          : "a restart is in flight";
      },
      deployBatchDataDir: runtimePaths.dataDir,
      // After a deploy/update job, step aside if a restart is now queued so the
      // launcher respawns this runner on the freshly deployed code (it otherwise
      // skips its own cycleManagementJobRunner while a job is running). The deploy
      // job writes the restart signal before it returns, so isRestartAlreadyInFlight
      // sees durable on-disk state here — not a race against the launcher.
      shouldStopAfterJob: (job) => {
        if (!isRestartAlreadyInFlight(runtimePaths.dataDir)) return false;
        runnerLog(`Restart queued by ${job.type} job — exiting for a clean respawn on the new code`);
        return true;
      },
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
