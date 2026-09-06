import type { RestartState } from "./restart-state.js";
import type { Schedule, ScheduleStore } from "./schedule-store.js";
import { matchesCron } from "./cron-next-run.js";
import { protectionRetryAt, type FocusProtectionStore } from "./focus-protection-store.js";
import type {
  FocusProtectionDisposition,
  FocusProtectionHold,
  FocusProtectionWindow,
  FocusProtectionWork,
} from "../shared/focus-protection.js";
import { safeSetTimeout, type LongTimeout } from "./long-timeout.js";

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
  waitForIdle(): Promise<void>;
  hold(schedule: Schedule, scheduledFor: string, window: FocusProtectionWindow): void;
  settle(scheduleId: string, disposition: FocusProtectionDisposition, scheduledFor?: string, details?: Record<string, unknown>): void;
  held(scheduleId: string, scheduledFor: string): ScheduleProtectionHold | undefined;
}

// The hold store preserves work metadata in its durable JSON payload.
interface ScheduleProtectionHold extends FocusProtectionHold {
  scheduleDefinition?: string;
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
  focusProtectionStore?: () => FocusProtectionStore | undefined;
  hasAutomaticRetry?: (scheduleId: string, scheduledFor: string) => boolean;
}

const MISSED_RUN_GRACE_WINDOW_MS = 60 * 60 * 1000;
const MISSED_RUN_CATCH_UP_RETRY_DELAY_MS = 5 * 1000;

function normalizeIso(value?: string | null): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function scheduleDefinition(schedule: Schedule): string {
  return JSON.stringify([schedule.type, schedule.cron ?? null, schedule.timezone ?? null, normalizeIso(schedule.runAt) ?? null]);
}

export function protectedScheduleDisposition(
  schedule: Schedule | undefined,
  held: Pick<ScheduleProtectionHold, "scheduledFor" | "scheduleDefinition">,
  now = Date.now(),
): FocusProtectionDisposition | undefined {
  if (!schedule) return "cancelled";
  if (schedule.expiresAt && Date.parse(schedule.expiresAt) <= now) return "expired";
  if (schedule.maxRuns && schedule.runCount >= schedule.maxRuns) return "no-longer-needed";
  if (held.scheduleDefinition && held.scheduleDefinition !== scheduleDefinition(schedule)) return "superseded";
  const lastRunAt = normalizeIso(schedule.lastRunAt);
  const alreadyRan = lastRunAt !== undefined && lastRunAt >= held.scheduledFor;
  if (schedule.type === "once") {
    if (normalizeIso(schedule.runAt) !== held.scheduledFor) return "superseded";
  } else {
    if (!schedule.cron || !matchesCron(schedule.cron, new Date(held.scheduledFor), schedule.timezone)) return "superseded";
    const nextRunAt = normalizeIso(schedule.nextRunAt);
    if (nextRunAt && nextRunAt !== held.scheduledFor) return alreadyRan ? "no-longer-needed" : "superseded";
  }
  if (!schedule.enabled) return alreadyRan ? "no-longer-needed" : "cancelled";
  return undefined;
}

export function createMissedRunCatchUpController(deps: MissedRunCatchUpDeps): MissedRunCatchUpController {
  let inFlight: Promise<void> | undefined;
  let requested = false;
  let retryTimer: LongTimeout | undefined;
  let retryAt = 0;
  let retryProtectionWindowId: string | undefined;
  const deferredCandidates = new Map<string, MissedRunCandidate>();
  const recordedHolds = new Map<string, Set<string>>();
  let generation = 0;
  let restartRequestedAtForNextCatchUp: string | null = null;
  let loggedRestartPendingSkip = false;

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    retryTimer.cancel();
    retryTimer = undefined;
    retryAt = 0;
    retryProtectionWindowId = undefined;
  }

  function scheduleRetry(at = Date.now() + MISSED_RUN_CATCH_UP_RETRY_DELAY_MS, windowId?: string): void {
    if (retryTimer && retryProtectionWindowId === windowId && retryAt <= at) return;
    clearRetryTimer();
    retryAt = at;
    retryProtectionWindowId = windowId;
    retryTimer = safeSetTimeout(() => {
      retryTimer = undefined;
      check();
    }, at - Date.now());
  }

  function rememberDeferred(candidates: Iterable<MissedRunCandidate>): void {
    for (const candidate of candidates) {
      deferredCandidates.set(getCandidateKey(candidate), candidate);
    }
  }

  function hold(schedule: Schedule, scheduledFor: string, window: FocusProtectionWindow): void {
    const key = `${schedule.id}:${scheduledFor}`;
    let windows = recordedHolds.get(key);
    if (!windows?.has(window.id)) {
      const work: FocusProtectionWork & { scheduleDefinition: string } = {
        kind: "schedule", workId: schedule.id, scheduledFor, title: schedule.name,
        scheduleDefinition: scheduleDefinition(schedule),
      };
      if (deps.focusProtectionStore?.()?.hold(window, work)) {
        console.log(`[scheduler] Postponing "${schedule.name}" until focus protection ends (${window.endsAt})`);
      }
      if (!windows) recordedHolds.set(key, windows = new Set());
      windows.add(window.id);
    }
    rememberDeferred([{
      id: schedule.id, name: schedule.name, source: schedule.type === "once" ? "once" : "catchup", scheduledFor,
    }]);
  }

  function held(scheduleId: string, scheduledFor: string): ScheduleProtectionHold | undefined {
    return deps.focusProtectionStore?.()?.outstanding("schedule")
      .find((work) => work.workId === scheduleId && work.scheduledFor === scheduledFor);
  }

  function settle(
    scheduleId: string,
    disposition: FocusProtectionDisposition,
    scheduledFor?: string,
    details?: Record<string, unknown>,
  ): void {
    deps.focusProtectionStore?.()?.settle({ kind: "schedule", workId: scheduleId, scheduledFor }, disposition, details);
    for (const [key, candidate] of deferredCandidates) {
      if (candidate.id === scheduleId && (scheduledFor === undefined || candidate.scheduledFor === scheduledFor)) {
        deferredCandidates.delete(key);
      }
    }
    for (const key of recordedHolds.keys()) {
      if (scheduledFor === undefined ? key.startsWith(`${scheduleId}:`) : key === `${scheduleId}:${scheduledFor}`) {
        recordedHolds.delete(key);
      }
    }
  }

  function restoreProtectionHolds(now: number): void {
    for (const work of deps.focusProtectionStore?.()?.outstanding("schedule") ?? []) {
      const schedule = deps.scheduleStore().getSchedule(work.workId);
      const disposition = protectedScheduleDisposition(schedule, work as ScheduleProtectionHold, now);
      if (disposition) {
        settle(work.workId, disposition, work.scheduledFor);
        if (!schedule || !schedule.enabled) {
          deps.unregisterSchedule(work.workId);
        } else if (disposition === "expired" || (schedule.maxRuns && schedule.runCount >= schedule.maxRuns)) {
          deps.scheduleStore().updateSchedule(schedule.id, { enabled: false });
          deps.unregisterSchedule(schedule.id);
        } else if (
          disposition === "superseded" && schedule.type === "cron" && schedule.cron
          && normalizeIso(schedule.nextRunAt) === work.scheduledFor
        ) {
          const nextRunAt = deps.computeNextRunAt(schedule.cron, schedule.timezone, new Date(now));
          if (nextRunAt) deps.scheduleStore().updateNextRunAt(schedule.id, nextRunAt);
        }
        continue;
      }
      const key = `${work.workId}:${work.scheduledFor}`;
      let windows = recordedHolds.get(key);
      if (!windows) recordedHolds.set(key, windows = new Set());
      windows.add(work.windowId);
      if (schedule && Date.parse(work.scheduledFor) <= now) {
        rememberDeferred([{
          id: schedule.id, name: schedule.name, source: schedule.type === "once" ? "once" : "catchup",
          scheduledFor: work.scheduledFor,
        }]);
      }
    }
  }

  function reset(): void {
    generation += 1;
    clearRetryTimer();
    inFlight = undefined;
    requested = false;
    deferredCandidates.clear();
    recordedHolds.clear();
    restartRequestedAtForNextCatchUp = null;
    loggedRestartPendingSkip = false;
  }

  function check(): void {
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
        if (runGeneration !== generation) return;
        inFlight = undefined;
        if (requested) {
          requested = false;
          check();
        }
      });
  }

  async function waitForIdle(): Promise<void> {
    // Delayed retries are intentionally not drained; tests must advance their
    // fake clock before waiting for the resulting in-flight check.
    while (inFlight) {
      await inFlight;
    }
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
    protection?: FocusProtectionWindow | null,
  ): boolean {
    if (scheduledTime >= now) return false;
    if ((now - scheduledTime) < MISSED_RUN_GRACE_WINDOW_MS) return true;
    if (protection && scheduledTime >= Date.parse(protection.startsAt) - MISSED_RUN_GRACE_WINDOW_MS) return true;
    if (deps.focusProtectionStore?.()?.coveringSlot(new Date(scheduledTime).toISOString(), now, MISSED_RUN_GRACE_WINDOW_MS)) return true;

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
      if (Date.parse(scheduledFor) > now) return undefined;
      return { id: schedule.id, name: schedule.name, source: "once", scheduledFor };
    }

    if (schedule.type !== "cron" || !schedule.cron) return undefined;
    const nextExpected = getNextExpectedCronRun(schedule);
    if (!nextExpected || nextExpected !== candidate.scheduledFor) return undefined;
    if (Date.parse(nextExpected) > now) return undefined;
    return { id: schedule.id, name: schedule.name, source: "catchup", scheduledFor: nextExpected };
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
    protection?: FocusProtectionWindow | null;
  }): MissedRunCandidate[] {
    const scheduleStore = deps.scheduleStore();
    const missedRuns: MissedRunCandidate[] = [];

    const dueAt = new Date(options.now).toISOString();
    for (const schedule of scheduleStore.listDueSchedules(dueAt)) {
      if (deps.focusProtectionStore?.() && (
        (schedule.expiresAt && Date.parse(schedule.expiresAt) <= options.now)
        || (schedule.maxRuns && schedule.runCount >= schedule.maxRuns)
      )) {
        settle(schedule.id, schedule.expiresAt && Date.parse(schedule.expiresAt) <= options.now ? "expired" : "no-longer-needed");
        scheduleStore.updateSchedule(schedule.id, { enabled: false });
        deps.unregisterSchedule(schedule.id);
        continue;
      }
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
        if (
          isEligibleMissedRunTime(runAtTime, options.now, options.restartRequestedAt, options.protection)
          || options.preservedCandidateKeys?.has(candidateKey)
        ) {
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
        isEligibleMissedRunTime(nextExpectedTime, options.now, options.restartRequestedAt, options.protection)
        || options.preservedCandidateKeys?.has(candidateKey)
      ) {
        missedRuns.push(candidate);
      } else if (!options.protection) {
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
    const now = Date.now();
    const protectionStore = deps.focusProtectionStore?.();
    const protection = protectionStore?.current(now);
    restoreProtectionHolds(now);
    const preservedCandidateKeys = new Set(deferredCandidates.keys());
    const restartRequestedAt = consumeRestartRequestedAt() ?? restartState.requestedAt;
    const currentMissedRuns = collectMissedRunCandidates({
      now,
      disableStaleOneShots: !protection,
      preservedCandidateKeys,
      restartRequestedAt,
      protection,
    });

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
    if (protection) {
      for (const candidate of missedRuns.values()) {
        const schedule = scheduleStore.getSchedule(candidate.id);
        if (schedule?.enabled) hold(schedule, candidate.scheduledFor, protection);
      }
      scheduleRetry(protectionRetryAt(protection, "schedule:catchup"), protection.id);
      return;
    }

    if (
      !retryProtectionWindowId || retryAt <= now
      || protectionStore?.get(retryProtectionWindowId, now)?.status !== "completed"
    ) clearRetryTimer();
    for (const schedule of missedRuns.values()) {
      const currentSchedule = scheduleStore.getSchedule(schedule.id);
      if (!currentSchedule || !currentSchedule.enabled) continue;
      const previousProtection = protectionStore?.coveringSlot(schedule.scheduledFor, now, MISSED_RUN_GRACE_WINDOW_MS);
      if (previousProtection) hold(currentSchedule, schedule.scheduledFor, previousProtection);
      if (deps.hasAutomaticRetry?.(schedule.id, schedule.scheduledFor)) {
        if (held(schedule.id, schedule.scheduledFor)) rememberDeferred([schedule]);
        continue;
      }
      const retryWindow = previousProtection ?? [...(recordedHolds.get(`${schedule.id}:${schedule.scheduledFor}`) ?? [])]
        .map((id) => protectionStore?.get(id, now))
        .find((window) => window?.status === "completed" && protectionRetryAt(window, "schedule:catchup") > now);
      if (retryWindow?.status === "completed") {
        const at = protectionRetryAt(retryWindow, "schedule:catchup");
        if (at > now) {
          rememberDeferred([schedule]);
          scheduleRetry(at, retryWindow.id);
          continue;
        }
      }
      console.log(`[scheduler] Missed run detected for "${schedule.name}" — catching up`);
      try {
        const result = await deps.triggerSchedule(schedule.id, {
          source: schedule.source,
          scheduledFor: schedule.scheduledFor,
        });
        if ("sessionId" in result) {
          if (recordedHolds.has(`${schedule.id}:${schedule.scheduledFor}`)) {
            settle(schedule.id, "started", schedule.scheduledFor, { sessionId: result.sessionId });
          }
        } else if (
          result.skipped === deps.getRestartPendingMessage()
          || held(schedule.id, schedule.scheduledFor)
        ) {
          rememberDeferred([schedule]);
          if (!deps.hasAutomaticRetry?.(schedule.id, schedule.scheduledFor)) scheduleRetry();
        }
      } catch (err) {
        if (held(schedule.id, schedule.scheduledFor)) {
          rememberDeferred([schedule]);
          if (!deps.hasAutomaticRetry?.(schedule.id, schedule.scheduledFor)) scheduleRetry();
        }
        console.error(`[scheduler] Catch-up trigger failed for "${schedule.name}":`, err);
      }
    }
  }

  return { check, reset, waitForIdle, hold, settle, held };
}
