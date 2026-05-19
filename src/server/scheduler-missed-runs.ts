import type { RestartState } from "./restart-state.js";
import type { Schedule, ScheduleStore } from "./schedule-store.js";

interface MissedRunCandidate {
  id: string;
  name: string;
  source: "once" | "catchup";
  scheduledFor: string;
}

type MissedRunTriggerResult = { sessionId: string } | { skipped: string };

export interface MissedRunCatchUpController {
  check(): void;
  reset(): void;
}

interface MissedRunCatchUpDeps {
  scheduleStore: () => ScheduleStore;
  computeNextRunAt: (cronExpr: string, timezone?: string, after?: Date) => string | undefined;
  unregisterSchedule: (scheduleId: string) => void;
  triggerSchedule: (
    scheduleId: string,
    options: { source: MissedRunCandidate["source"]; scheduledFor: string },
  ) => Promise<MissedRunTriggerResult>;
  isRestartPending: () => boolean;
  refreshRestartState: () => Promise<RestartState>;
  getRestartPendingMessage: () => string;
}

const MISSED_RUN_GRACE_WINDOW_MS = 60 * 60 * 1000;
const MISSED_RUN_CATCH_UP_RETRY_DELAY_MS = 5 * 1000;

export function createMissedRunCatchUpController(deps: MissedRunCatchUpDeps): MissedRunCatchUpController {
  let inFlight: Promise<void> | undefined;
  let requested = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const deferredCandidates = new Map<string, MissedRunCandidate>();
  let generation = 0;
  let restartRequestedAtForNextCatchUp: string | null = null;
  let loggedRestartPendingSkip = false;

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function scheduleRetry(): void {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      check();
    }, MISSED_RUN_CATCH_UP_RETRY_DELAY_MS);
  }

  function rememberDeferred(candidates: Iterable<MissedRunCandidate>): void {
    for (const candidate of candidates) {
      deferredCandidates.set(getCandidateKey(candidate), candidate);
    }
  }

  function reset(): void {
    generation += 1;
    clearRetryTimer();
    inFlight = undefined;
    requested = false;
    deferredCandidates.clear();
    restartRequestedAtForNextCatchUp = null;
    loggedRestartPendingSkip = false;
  }

  function check(): void {
    clearRetryTimer();
    if (inFlight) {
      requested = true;
      return;
    }
    if (deps.isRestartPending()) {
      scheduleRetry();
    }
    const runGeneration = generation;
    inFlight = catchUpMissedRuns(runGeneration)
      .catch((err) => {
        console.error("[scheduler] Failed missed-run catch-up:", err);
      })
      .finally(() => {
        inFlight = undefined;
        if (requested) {
          requested = false;
          check();
        }
      });
  }

  function getCandidateKey(candidate: MissedRunCandidate): string {
    return `${candidate.id}:${candidate.source}:${candidate.scheduledFor}`;
  }

  function rememberRestartRequestedAt(value?: string | null): void {
    const normalized = normalizeIso(value);
    if (!normalized) return;
    if (
      !restartRequestedAtForNextCatchUp
      || Date.parse(normalized) < Date.parse(restartRequestedAtForNextCatchUp)
    ) {
      restartRequestedAtForNextCatchUp = normalized;
    }
  }

  function consumeRestartRequestedAt(): string | null {
    const requestedAt = restartRequestedAtForNextCatchUp;
    restartRequestedAtForNextCatchUp = null;
    return requestedAt;
  }

  function isEligibleMissedRunTime(
    scheduledTime: number,
    now: number,
    restartRequestedAt?: string | null,
  ): boolean {
    if (scheduledTime >= now) return false;
    if ((now - scheduledTime) < MISSED_RUN_GRACE_WINDOW_MS) return true;

    if (!restartRequestedAt) return false;
    const restartRequestedTime = Date.parse(restartRequestedAt);
    if (Number.isNaN(restartRequestedTime)) return false;
    return scheduledTime >= (restartRequestedTime - MISSED_RUN_GRACE_WINDOW_MS);
  }

  function revalidateDeferredCandidate(candidate: MissedRunCandidate, now: number): MissedRunCandidate | undefined {
    const schedule = deps.scheduleStore().getSchedule(candidate.id);
    if (!schedule || !schedule.enabled) return undefined;

    if (candidate.source === "once") {
      if (schedule.type !== "once" || !schedule.runAt) return undefined;
      const scheduledFor = new Date(schedule.runAt).toISOString();
      if (scheduledFor !== candidate.scheduledFor) return undefined;
      if (Date.parse(scheduledFor) >= now) return undefined;
      return { id: schedule.id, name: schedule.name, source: "once", scheduledFor };
    }

    if (schedule.type !== "cron" || !schedule.cron) return undefined;
    const nextExpected = getNextExpectedCronRun(schedule);
    if (!nextExpected || nextExpected !== candidate.scheduledFor) return undefined;
    if (Date.parse(nextExpected) >= now) return undefined;
    return { id: schedule.id, name: schedule.name, source: "catchup", scheduledFor: nextExpected };
  }

  function normalizeIso(value?: string | null): string | undefined {
    if (!value) return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
  }

  function getNextExpectedCronRun(schedule: Schedule): string | undefined {
    if (schedule.type !== "cron" || !schedule.cron) return undefined;
    const nextRunAt = normalizeIso(schedule.nextRunAt);
    if (nextRunAt) return nextRunAt;
    const lastRunAt = normalizeIso(schedule.lastRunAt);
    return lastRunAt ? deps.computeNextRunAt(schedule.cron, schedule.timezone, new Date(lastRunAt)) : undefined;
  }

  function collectMissedRunCandidates(options: {
    now: number;
    disableStaleOneShots: boolean;
    preservedCandidateKeys?: ReadonlySet<string>;
    restartRequestedAt?: string | null;
  }): MissedRunCandidate[] {
    const scheduleStore = deps.scheduleStore();
    const missedRuns: MissedRunCandidate[] = [];

    const dueAt = new Date(options.now).toISOString();
    for (const schedule of scheduleStore.listDueSchedules(dueAt)) {
      if (schedule.type === "once") {
        if (!schedule.runAt) continue;
        const candidate: MissedRunCandidate = {
          id: schedule.id,
          name: schedule.name,
          source: "once",
          scheduledFor: new Date(schedule.runAt).toISOString(),
        };
        const candidateKey = getCandidateKey(candidate);
        const runAtTime = new Date(schedule.runAt).getTime();
        if (runAtTime >= options.now) continue;
        if (isEligibleMissedRunTime(runAtTime, options.now, options.restartRequestedAt)) {
          missedRuns.push(candidate);
        } else if (options.disableStaleOneShots && !options.preservedCandidateKeys?.has(candidateKey)) {
          console.log(`[scheduler] One-shot "${schedule.name}" is stale — disabling without replay`);
          scheduleStore.updateSchedule(schedule.id, { enabled: false });
          deps.unregisterSchedule(schedule.id);
        }
        continue;
      }

      if (!schedule.cron) continue;
      const nextExpected = getNextExpectedCronRun(schedule);
      if (!nextExpected) continue;

      const candidate: MissedRunCandidate = {
        id: schedule.id,
        name: schedule.name,
        source: "catchup",
        scheduledFor: nextExpected,
      };
      const candidateKey = getCandidateKey(candidate);
      const nextExpectedTime = new Date(nextExpected).getTime();
      if (nextExpectedTime >= options.now) continue;
      if (
        isEligibleMissedRunTime(nextExpectedTime, options.now, options.restartRequestedAt)
        || options.preservedCandidateKeys?.has(candidateKey)
      ) {
        missedRuns.push(candidate);
      } else {
        const nextRunAt = deps.computeNextRunAt(schedule.cron, schedule.timezone);
        if (nextRunAt) {
          console.log(`[scheduler] Cron "${schedule.name}" missed slot ${nextExpected} is stale — advancing without replay`);
          scheduleStore.updateNextRunAt(schedule.id, nextRunAt);
        }
      }
    }

    return missedRuns;
  }

  async function catchUpMissedRuns(runGeneration: number): Promise<void> {
    const restartState = await deps.refreshRestartState();
    if (runGeneration !== generation) return;
    const restartPending = restartState.phase !== "idle";
    if (restartPending) {
      rememberRestartRequestedAt(restartState.requestedAt);
      scheduleRetry();
      if (!loggedRestartPendingSkip) {
        console.log("[scheduler] Skipping missed-run catch-up while restart is pending");
        loggedRestartPendingSkip = true;
      }
      return;
    }

    loggedRestartPendingSkip = false;
    const preservedCandidateKeys = new Set(deferredCandidates.keys());
    const restartRequestedAt = consumeRestartRequestedAt() ?? restartState.requestedAt;
    const currentMissedRuns = collectMissedRunCandidates({
      now: Date.now(),
      disableStaleOneShots: true,
      preservedCandidateKeys,
      restartRequestedAt,
    });
    clearRetryTimer();

    const missedRuns = new Map<string, MissedRunCandidate>();
    for (const deferredCandidate of deferredCandidates.values()) {
      const revalidatedCandidate = revalidateDeferredCandidate(deferredCandidate, Date.now());
      if (revalidatedCandidate) {
        missedRuns.set(getCandidateKey(revalidatedCandidate), revalidatedCandidate);
      }
    }
    for (const schedule of currentMissedRuns) {
      missedRuns.set(getCandidateKey(schedule), schedule);
    }
    deferredCandidates.clear();

    const scheduleStore = deps.scheduleStore();
    for (const schedule of missedRuns.values()) {
      const currentSchedule = scheduleStore.getSchedule(schedule.id);
      if (!currentSchedule || !currentSchedule.enabled) continue;
      console.log(`[scheduler] Missed run detected for "${schedule.name}" — catching up`);
      try {
        const result = await deps.triggerSchedule(schedule.id, {
          source: schedule.source,
          scheduledFor: schedule.scheduledFor,
        });
        if ("skipped" in result && result.skipped === deps.getRestartPendingMessage()) {
          deferredCandidates.set(getCandidateKey(schedule), schedule);
          scheduleRetry();
        }
      } catch (err) {
        console.error(`[scheduler] Catch-up trigger failed for "${schedule.name}":`, err);
      }
    }
  }

  return { check, reset };
}
