// Event-driven staging preview discovery.
//
// Staging previews are built by the separate management-job-runner process, so the
// live server never observes the build in-process. The management_jobs table is the
// only authoritative shared signal, and SQLite offers no cross-process change feed.
// This controller therefore watches a job row only for the lifetime of that job:
// discovery runs when a watched job reaches a terminal state, and every timer stops
// as soon as no job is being watched. No permanent background interval remains.

import {
  getManagementJobStaleAfterMs,
  type ManagementJob,
  type ManagementJobStatus,
  type ManagementJobStore,
  type ManagementJobType,
} from "./management-job-store.js";

/** Job types whose completion changes preview artifacts on disk. */
const PREVIEW_DISCOVERY_JOB_TYPES: readonly ManagementJobType[] = [
  "staging_preview",
  "staging_deploy",
];

const TERMINAL_STATUSES: ReadonlySet<ManagementJobStatus> = new Set<ManagementJobStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/**
 * How long a claimed job may go without any row update before it is treated as
 * abandoned. The runner heartbeats every few seconds and claimNext() rewrites the
 * row when it picks a job up, so this only elapses for jobs no runner will ever
 * finish — it must never be an absolute cap on a job that is still progressing.
 */
const DEFAULT_MAX_IDLE_WATCH_MS = 60 * 60_000;
/**
 * Final termination guarantee for a row that is never claimed. A queued row has no
 * writer at all until claimNext() picks it up, so queue waits are exempt from the
 * idle window; this bound keeps an endlessly queued row (runner down) from being
 * watched forever. Startup resume re-adopts anything still active after a restart.
 */
const DEFAULT_MAX_TOTAL_WATCH_MS = 12 * 60 * 60_000;

export type StagingPreviewDiscoveryReason =
  | "job-completed"
  | "job-missing"
  | "job-stalled"
  | "watch-expired"
  | "requested";

export interface StagingPreviewDiscoveryTrigger {
  reason: StagingPreviewDiscoveryReason;
  /** Jobs observed reaching a terminal status in this batch. Empty for other reasons. */
  completedJobs: ManagementJob[];
}

export interface StagingPreviewDiscoveryDeps {
  store: ManagementJobStore;
  discover: (trigger: StagingPreviewDiscoveryTrigger) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
  pollIntervalMs?: number;
  staleHeartbeatMs?: number;
  /** Idle window: how long a claimed job may go without any row update. */
  maxIdleWatchMs?: number;
  /** Hard ceiling on watching a job that is never claimed out of the queue. */
  maxTotalWatchMs?: number;
}

export interface StagingPreviewDiscoveryController {
  /** Watch a queued/running preview-affecting job until it reaches a terminal state. */
  watchJob(job: ManagementJob): void;
  /** Startup resume: watch jobs a previous process left active. */
  resumeActiveJobs(): void;
  /** Run discovery once. Coalesces with any in-flight or queued run. */
  requestDiscovery(reason?: StagingPreviewDiscoveryReason): Promise<void>;
  watchedJobIds(): string[];
  hasScheduledWork(): boolean;
  stop(): void;
}

interface WatchEntry {
  idleDeadlineMs: number;
  totalDeadlineMs: number;
  lastUpdatedAt: string;
  stalledRescanDone: boolean;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPreviewDiscoveryJobType(type: ManagementJobType): boolean {
  return PREVIEW_DISCOVERY_JOB_TYPES.includes(type);
}

export function createStagingPreviewDiscovery(
  deps: StagingPreviewDiscoveryDeps,
): StagingPreviewDiscoveryController {
  const writeLog = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleHeartbeatMs = deps.staleHeartbeatMs ?? getManagementJobStaleAfterMs();
  const maxIdleWatchMs = deps.maxIdleWatchMs ?? DEFAULT_MAX_IDLE_WATCH_MS;
  const maxTotalWatchMs = deps.maxTotalWatchMs ?? DEFAULT_MAX_TOTAL_WATCH_MS;

  const watched = new Map<string, WatchEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ticking = false;
  let stopped = false;

  // Every discovery run — timer-driven or requested — funnels through one drain so
  // async cleanup never interleaves with registration on the shared preview maps.
  let drainPromise: Promise<void> | null = null;
  let queuedReason: StagingPreviewDiscoveryReason | null = null;
  const queuedJobs = new Map<string, ManagementJob>();

  function schedule(): void {
    if (stopped || timer || ticking || watched.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, pollIntervalMs);
    timer.unref?.();
  }

  function isStaleRunningJob(job: ManagementJob): boolean {
    if (job.status !== "running") return false;
    const heartbeatMs = parseTimestamp(job.heartbeatAt) ?? parseTimestamp(job.startedAt);
    if (heartbeatMs === null) return false;
    return now() - heartbeatMs >= staleHeartbeatMs;
  }

  async function drain(): Promise<void> {
    try {
      while (queuedReason !== null) {
        const trigger: StagingPreviewDiscoveryTrigger = {
          reason: queuedReason,
          completedJobs: [...queuedJobs.values()],
        };
        queuedReason = null;
        queuedJobs.clear();
        try {
          await deps.discover(trigger);
        } catch (error) {
          writeLog(
            `Warning: staging preview discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      drainPromise = null;
    }
  }

  function requestDiscovery(
    reason: StagingPreviewDiscoveryReason = "requested",
    completedJobs: ManagementJob[] = [],
  ): Promise<void> {
    // A completed job is the most specific reason; never let a plain rescan mask it.
    if (completedJobs.length > 0) {
      queuedReason = "job-completed";
    } else {
      queuedReason ??= reason;
    }
    for (const job of completedJobs) {
      queuedJobs.set(job.id, job);
    }
    if (!drainPromise) {
      drainPromise = drain();
    }
    return drainPromise;
  }

  async function tick(): Promise<void> {
    ticking = true;
    try {
      if (stopped) return;

      const completedJobs: ManagementJob[] = [];
      let fallbackReason: StagingPreviewDiscoveryReason | null = null;
      const nowMs = now();

      for (const [jobId, entry] of [...watched]) {
        let job: ManagementJob | null;
        try {
          job = deps.store.get(jobId);
        } catch (error) {
          // Transient read failure: keep watching and retry on the next tick.
          writeLog(
            `Warning: staging preview discovery could not read management job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        if (!job) {
          watched.delete(jobId);
          fallbackReason ??= "job-missing";
          continue;
        }

        if (TERMINAL_STATUSES.has(job.status)) {
          watched.delete(jobId);
          completedJobs.push(job);
          continue;
        }

        // A stalled runner may still be reclaimed by claimNext(), so keep watching.
        // One defensive rescan picks up artifacts a crashed runner already wrote.
        if (isStaleRunningJob(job)) {
          if (!entry.stalledRescanDone) {
            entry.stalledRescanDone = true;
            fallbackReason ??= "job-stalled";
            writeLog(`Staging preview discovery: management job ${jobId} looks stalled — rescanning previews once`);
          }
        } else {
          entry.stalledRescanDone = false;
        }

        // A queued row has no writer until claimNext() picks it up, so its
        // updatedAt is frozen while it waits behind other jobs: queue wait is not
        // idleness. Any row update (claim, heartbeat, status change) is progress.
        if (job.status === "queued" || job.updatedAt !== entry.lastUpdatedAt) {
          entry.lastUpdatedAt = job.updatedAt;
          entry.idleDeadlineMs = nowMs + maxIdleWatchMs;
        }

        // The total bound only ends an endless queue wait. Once a job is claimed it
        // is bounded by the idle window instead, so a job that starts running just
        // before the ceiling is still watched through to completion.
        const queuedTooLong = job.status === "queued" && nowMs >= entry.totalDeadlineMs;
        if (nowMs >= entry.idleDeadlineMs || queuedTooLong) {
          watched.delete(jobId);
          fallbackReason ??= "watch-expired";
          writeLog(`Staging preview discovery: stopped watching management job ${jobId} after its ${queuedTooLong ? "maximum queued" : "idle"} watch window elapsed`);
        }
      }

      if (completedJobs.length > 0) {
        await requestDiscovery("job-completed", completedJobs);
      } else if (fallbackReason) {
        await requestDiscovery(fallbackReason);
      }
    } finally {
      ticking = false;
      schedule();
    }
  }

  function watchJob(job: ManagementJob): void {
    if (stopped) return;
    if (!isPreviewDiscoveryJobType(job.type)) return;
    if (TERMINAL_STATUSES.has(job.status)) return;
    // Re-noting a reused job must not restart its idle window.
    if (watched.has(job.id)) return;
    // The windows are anchored to adoption, not creation: a job resumed long after
    // a restart is still going to be built by the runner.
    watched.set(job.id, {
      idleDeadlineMs: now() + maxIdleWatchMs,
      totalDeadlineMs: now() + maxTotalWatchMs,
      lastUpdatedAt: job.updatedAt,
      stalledRescanDone: false,
    });
    schedule();
  }

  function resumeActiveJobs(): void {
    if (stopped) return;
    let active: ManagementJob[];
    try {
      active = deps.store.listActive(PREVIEW_DISCOVERY_JOB_TYPES);
    } catch (error) {
      writeLog(
        `Warning: staging preview discovery could not resume active management jobs: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const job of active) {
      watchJob(job);
    }
    if (active.length > 0) {
      writeLog(`Staging preview discovery watching ${active.length} active management job(s)`);
    }
  }

  return {
    watchJob,
    resumeActiveJobs,

    requestDiscovery(reason: StagingPreviewDiscoveryReason = "requested"): Promise<void> {
      if (stopped) return Promise.resolve();
      return requestDiscovery(reason);
    },

    watchedJobIds(): string[] {
      return [...watched.keys()];
    },

    hasScheduledWork(): boolean {
      return timer !== null || ticking || drainPromise !== null;
    },

    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watched.clear();
      queuedReason = null;
      queuedJobs.clear();
    },
  };
}
