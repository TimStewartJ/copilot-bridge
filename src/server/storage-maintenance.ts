/**
 * Recurring storage maintenance.
 *
 * The append-heavy tables (`telemetry_spans`, `management_jobs`) and Bridge's
 * on-disk log artifacts were only pruned during `main()`. This process is
 * long-lived, so a startup-only sweep means an instance that stays up for months
 * never prunes again and those stores grow without bound between restarts.
 */

export interface StorageMaintenanceOptions {
  /** Prune telemetry spans older than the retention window. */
  pruneTelemetrySpans: () => void;
  /** Prune management job rows plus validation/job log files. */
  pruneLogArtifacts: () => Promise<void>;
  intervalMs: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface StorageMaintenance {
  /** Run one sweep. Never rejects: a failing sweep must not stop the next one. */
  runOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

export function createStorageMaintenance(options: StorageMaintenanceOptions): StorageMaintenance {
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  async function sweep(): Promise<void> {
    try {
      options.pruneTelemetrySpans();
    } catch (error) {
      console.error("[storage-maintenance] Telemetry prune failed:", error);
    }
    try {
      await options.pruneLogArtifacts();
    } catch (error) {
      console.error("[storage-maintenance] Log artifact prune failed:", error);
    }
  }

  function runOnce(): Promise<void> {
    // A slow sweep must not stack up behind the interval.
    if (inFlight) return inFlight;
    inFlight = sweep().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setIntervalFn(() => { void runOnce(); }, options.intervalMs);
      // Maintenance must never be the reason the process refuses to exit.
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = undefined;
    },
  };
}
