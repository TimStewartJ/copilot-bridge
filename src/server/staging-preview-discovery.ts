// Watches job rows only while they run (no cross-process feed); no permanent interval.

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
/** Idle window since the last row update (heartbeats reset it); never a cap on a running job. */
const DEFAULT_MAX_IDLE_WATCH_MS = 60 * 60_000;
/** Caps only queue waits (queued rows get no updates); claimed jobs use the idle window. */
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
  /** Awaits the tick's async work too; a timer advance alone doesn't mean it finished. */
  settle(): Promise<void>;
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
  // The running tick, so settle() can await async work a timer callback started.
  let tickPromise: Promise<void> | null = null;

  // All runs share one drain so async cleanup never interleaves with registration.
  let drainPromise: Promise<void> | null = null;
  let queuedReason: StagingPreviewDiscoveryReason | null = null;
  const queuedJobs = new Map<string, ManagementJob>();

  function schedule(): void {
    if (stopped || timer || ticking || watched.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      tickPromise = tick().finally(() => {
        tickPromise = null;
      });
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
        const reason = queuedReason;
        if (reason === null) continue;
        const trigger: StagingPreviewDiscoveryTrigger = {
          reason,
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

        // claimNext() may still reclaim a stalled job; rescan once for what a crashed runner wrote.
        if (isStaleRunningJob(job)) {
          if (!entry.stalledRescanDone) {
            entry.stalledRescanDone = true;
            fallbackReason ??= "job-stalled";
            writeLog(`Staging preview discovery: management job ${jobId} looks stalled — rescanning previews once`);
          }
        } else {
          entry.stalledRescanDone = false;
        }

        // Queued rows are never updated, so waiting isn't idle; any row update is progress.
        if (job.status === "queued" || job.updatedAt !== entry.lastUpdatedAt) {
          entry.lastUpdatedAt = job.updatedAt;
          entry.idleDeadlineMs = nowMs + maxIdleWatchMs;
        }

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
    // Windows start at adoption, not creation: a job resumed long after a restart still gets built.
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

    async settle(): Promise<void> {
      // A tick may enqueue a drain and a drain may wait on a tick, so loop until both are idle.
      while (tickPromise || drainPromise) {
        await (tickPromise ?? Promise.resolve());
        await (drainPromise ?? Promise.resolve());
      }
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
