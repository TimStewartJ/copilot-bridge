import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, type DatabaseSync } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { createScheduleStore, type ScheduleCreate } from "../schedule-store.js";
import { createTaskStore } from "../task-store.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createFocusProtectionStore, protectionRetryAt } from "../focus-protection-store.js";
import { createMissedRunCatchUpController, type MissedRunCatchUpController } from "../scheduler-missed-runs.js";
import type { SessionManager } from "../session-manager.js";
import type { RestartState } from "../restart-state.js";
import * as scheduler from "../scheduler.js";

const state = vi.hoisted(() => ({
  phase: "idle",
  requestedAt: null as string | null,
  cronTicks: [] as Array<() => void>,
  cronMissed: [] as Array<() => void>,
}));

vi.mock("../session-manager.js", () => {
  const current = () => ({
    requestId: state.phase === "idle" ? null : "restart",
    phase: state.phase,
    requestedAt: state.requestedAt,
    waitingSessions: 0,
    launcherHeartbeatAt: null,
    releaseFailure: null,
  });
  return {
    isRestartPending: () => state.phase !== "idle",
    isRestartCutoverInProgress: (restart: RestartState) => restart.phase === "restarting",
    refreshRestartState: async () => current(),
    refreshRestartStateSync: current,
    isRestartPendingError: (error: unknown) => error instanceof Error && error.message === "Restart pending",
    RESTART_PENDING_MESSAGE: "Restart pending",
  };
});

vi.mock("node-cron", () => ({
  default: {
    validate: () => true,
    schedule: (_expression: string, tick: () => void) => {
      state.cronTicks.push(tick);
      return {
        stop: vi.fn(),
        on: (_event: string, callback: () => void) => state.cronMissed.push(callback),
      };
    },
  },
}));

const START = "2026-09-05T10:00:00.000Z";
const END = "2026-09-05T12:00:00.000Z";
const ORIGINAL_SLOT = "2026-09-05T09:30:00.000Z";
const databases: DatabaseSync[] = [];
const controllers: MissedRunCatchUpController[] = [];
const protectionStores: ReturnType<typeof createFocusProtectionStore>[] = [];

function fixture() {
  const db = openMemoryDatabase();
  databases.push(db);
  const globalBus = createGlobalBus();
  const scheduleStore = createScheduleStore(db);
  const taskStore = createTaskStore(db, globalBus);
  const sessionMetaStore = createSessionMetaStore(db);
  const focusProtectionStore = createFocusProtectionStore(db, globalBus);
  protectionStores.push(focusProtectionStore);
  const task = taskStore.createTask("Protected task");
  let sessionNumber = 0;
  let scheduleNumber = 0;
  const manager = {
    createTaskSession: vi.fn(async (..._args: unknown[]) => ({ sessionId: `protected-session-${++sessionNumber}` })),
    startWork: vi.fn(),
    isSessionBusy: vi.fn(() => false),
    deleteSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => true),
  };
  const deps = { scheduleStore, taskStore, sessionMetaStore, globalBus, focusProtectionStore };
  const createSchedule = (type: "cron" | "once", slot = ORIGINAL_SLOT, overrides: Partial<ScheduleCreate> = {}) => {
    const schedule = scheduleStore.createSchedule({
      taskId: task.id,
      name: `${type}-work-${++scheduleNumber}`,
      prompt: "Run the original scheduled work",
      type,
      ...(type === "once" ? { runAt: slot } : { cron: "*/30 * * * *" }),
      timezone: "UTC",
      ...overrides,
    });
    scheduleStore.updateNextRunAt(schedule.id, slot);
    return scheduleStore.getSchedule(schedule.id)!;
  };
  return {
    db, manager, deps, ...deps, createSchedule,
    protect: (endsAt = END) => focusProtectionStore.create({ endsAt, timezone: "UTC", reason: "Deep work" }),
    start: async (watchdog = false) => {
      scheduler.initialize(manager as unknown as SessionManager, deps);
      if (!watchdog) scheduler.stopMissedRunWatchdogForTests();
      await scheduler.waitForMissedRunCatchUpForTests();
    },
    claims: (id: string) => db.prepare(
      "SELECT runKey, source, status FROM schedule_run_claims WHERE scheduleId=? ORDER BY runKey",
    ).all(id),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  state.phase = "idle";
  state.requestedAt = null;
  state.cronTicks.length = 0;
  state.cronMissed.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  scheduler.shutdown();
  for (const controller of controllers.splice(0)) controller.reset();
  for (const store of protectionStores.splice(0)) store.stop();
  await Promise.resolve();
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("protected scheduler admission", () => {
  it("holds cron and once synchronously without claims or active-run occupancy, while manual requests bypass protection", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    await ctx.start();
    const claimSchedule = vi.spyOn(ctx.scheduleStore, "claimScheduleRun");
    const claimSlot = vi.spyOn(ctx.scheduleStore, "claimAutomaticRun");
    const skipSlot = vi.spyOn(ctx.scheduleStore, "skipAutomaticRun");
    const release = vi.spyOn(ctx.scheduleStore, "releaseClaimedAutomaticRun");
    const schedules = ["cron", "once", "cron", "once"].map((type) => ctx.createSchedule(type as "cron" | "once", START));

    for (const schedule of schedules) {
      const attempt = scheduler.triggerSchedule(schedule.id, { source: schedule.type, scheduledFor: START });
      expect(ctx.manager.createTaskSession).not.toHaveBeenCalled();
      expect(ctx.claims(schedule.id)).toEqual([]);
      expect(await attempt).toEqual({ skipped: scheduler.FOCUS_PROTECTION_MESSAGE });
    }
    expect(claimSchedule).not.toHaveBeenCalled();
    expect(claimSlot).not.toHaveBeenCalled();
    expect(skipSlot).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ postponed: 4, pending: 4 });

    const manual = ctx.createSchedule("cron", START);
    expect(await scheduler.triggerSchedule(manual.id)).toEqual({ sessionId: "protected-session-1" });
    expect(ctx.manager.startWork).toHaveBeenCalledOnce();
    expect(ctx.focusProtectionStore.outstanding("schedule")).toHaveLength(4);
  });

  it("lets an admitted in-flight creation finish if protection starts while it awaits the session", async () => {
    const ctx = fixture();
    await ctx.start();
    const schedule = ctx.createSchedule("once", START);
    let release!: (session: { sessionId: string }) => void;
    ctx.manager.createTaskSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const run = scheduler.triggerSchedule(schedule.id, { source: "once", scheduledFor: START });
    expect(ctx.manager.createTaskSession).toHaveBeenCalledOnce();
    const window = ctx.protect();
    release({ sessionId: "already-admitted" });

    expect(await run).toEqual({ sessionId: "already-admitted" });
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.manager.startWork).toHaveBeenCalledWith("already-admitted", schedule.prompt);
    expect(ctx.manager.deleteSession).not.toHaveBeenCalled();
    expect(ctx.focusProtectionStore.impacts(window.id).pending).toBe(0);
    expect(ctx.claims(schedule.id)).toEqual([{ runKey: START, source: "once", status: "triggered" }]);
  });

  it("re-arms a held one-shot at end plus deterministic jitter, never at the 30-second fallback", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const slot = "2026-09-05T10:00:01.000Z";
    const schedule = ctx.createSchedule("once", slot);
    const hold = vi.spyOn(ctx.focusProtectionStore, "hold");
    ctx.focusProtectionStore.start();
    await ctx.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.waitForMissedRunCatchUpForTests();
    const retryAt = protectionRetryAt(window, `${schedule.id}:${slot}`);
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.nextRunAt).toBe(new Date(retryAt).toISOString());
    expect(retryAt).toBeGreaterThan(Date.parse(END));
    expect(retryAt).toBeLessThanOrEqual(Date.parse(END) + 3_000);
    expect(ctx.claims(schedule.id)).toEqual([]);
    const timers = vi.getTimerCount();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(hold).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(timers);
    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await scheduler.waitForMissedRunCatchUpForTests();

    expect(ctx.manager.startWork).toHaveBeenCalledOnce();
    expect(ctx.claims(schedule.id)).toEqual([{ runKey: slot, source: "once", status: "triggered" }]);
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({
      postponed: 1, pending: 0, dispositions: { started: 1 },
    });
  });

  it("deduplicates repeated cron ticks, missed-execution signals, and watchdog suppression across a two-hour window", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const schedule = ctx.createSchedule("cron");
    const hold = vi.spyOn(ctx.focusProtectionStore, "hold");
    await ctx.start(true);
    state.cronTicks[0]();
    await scheduler.waitForMissedRunCatchUpForTests();
    const timers = vi.getTimerCount();
    for (let minute = 0; minute < 100; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      state.cronTicks[0]();
      state.cronMissed[0]();
      await scheduler.waitForMissedRunCatchUpForTests();
      expect(scheduler.getCronTriggerScheduledFor(schedule.id)).toBe(ORIGINAL_SLOT);
    }

    expect(hold).toHaveBeenCalledOnce();
    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
    expect(ctx.claims(schedule.id)).toEqual([]);
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.nextRunAt).toBe(ORIGINAL_SLOT);
    expect(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes("Postponing"))).toHaveLength(1);
    expect(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes("Missed run detected"))).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(Date.parse(END) + 3_001 - Date.now());
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.manager.startWork).toHaveBeenCalledOnce();
    expect(ctx.claims(schedule.id)).toEqual([{
      runKey: ORIGINAL_SLOT, source: expect.stringMatching(/cron|catchup/), status: "triggered",
    }]);
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ postponed: 1, pending: 0 });
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.nextRunAt).toBe("2026-09-05T12:30:00.000Z");
  });

  it("promptly releases cancellation through catch-up without duplicate cron or once retries", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const cron = ctx.createSchedule("cron");
    const once = ctx.createSchedule("once");
    await ctx.start();
    await scheduler.triggerSchedule(cron.id, { source: "cron", scheduledFor: ORIGINAL_SLOT });
    await scheduler.triggerSchedule(once.id, { source: "once", scheduledFor: ORIGINAL_SLOT });
    expect(ctx.focusProtectionStore.outstanding("schedule")).toHaveLength(2);

    ctx.focusProtectionStore.cancel(window.id);
    ctx.globalBus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
    ctx.globalBus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.manager.startWork).toHaveBeenCalledTimes(2);
    expect(ctx.claims(cron.id)).toEqual([{ runKey: ORIGINAL_SLOT, source: "catchup", status: "triggered" }]);
    expect(ctx.claims(once.id)).toEqual([{ runKey: ORIGINAL_SLOT, source: "once", status: "triggered" }]);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 3_001);
    expect(ctx.manager.startWork).toHaveBeenCalledTimes(2);
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({
      postponed: 2, pending: 0, dispositions: { started: 2 },
    });
  });

  it("releases a held one-shot immediately when cancellation shares its exact scheduled timestamp", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    await ctx.start();
    const schedule = ctx.createSchedule("once", START);
    await scheduler.triggerSchedule(schedule.id, { source: "once", scheduledFor: START });
    ctx.focusProtectionStore.cancel(window.id);
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.manager.startWork).toHaveBeenCalledOnce();
    expect(ctx.claims(schedule.id)).toEqual([{ runKey: START, source: "once", status: "triggered" }]);
  });

  it("retains the existing global-pause and restart-cutover gates for automatic and manual triggers", async () => {
    const ctx = fixture();
    ctx.protect();
    await ctx.start();
    const schedule = ctx.createSchedule("cron", START);
    scheduler.setGlobalPause(true);
    expect(await scheduler.triggerSchedule(schedule.id)).toEqual({ skipped: "Scheduling is globally paused" });
    expect(await scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: START }))
      .toEqual({ skipped: "Scheduling is globally paused" });
    scheduler.setGlobalPause(false);
    state.phase = "restarting";
    expect(await scheduler.triggerSchedule(schedule.id)).toEqual({ skipped: "Restart pending" });
    expect(await scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: START }))
      .toEqual({ skipped: "Restart pending" });
    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    expect(ctx.claims(schedule.id)).toEqual([]);
    expect(ctx.focusProtectionStore.outstanding("schedule")).toEqual([]);

    state.phase = "waiting-for-sessions";
    expect(await scheduler.triggerSchedule(schedule.id)).toEqual({ sessionId: "protected-session-1" });
  });
});

describe("durable protected missed-run recovery", () => {
  it("rebuilds aged cron and once candidates after booting 90 minutes into protection, then recovers original slots after another restart", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const cron = ctx.createSchedule("cron");
    const once = ctx.createSchedule("once");
    vi.setSystemTime("2026-09-05T11:30:00.000Z");
    await ctx.start();
    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    expect(ctx.scheduleStore.getSchedule(cron.id)?.nextRunAt).toBe(ORIGINAL_SLOT);
    expect(ctx.scheduleStore.getSchedule(once.id)?.enabled).toBe(true);
    expect(ctx.focusProtectionStore.outstanding("schedule").map((work) => work.scheduledFor)).toEqual([
      ORIGINAL_SLOT, ORIGINAL_SLOT,
    ]);
    scheduler.shutdown();

    vi.setSystemTime("2026-09-05T12:30:00.000Z");
    await ctx.start();
    expect(ctx.manager.startWork).toHaveBeenCalledTimes(2);
    for (const schedule of [cron, once]) {
      expect(ctx.claims(schedule.id)).toEqual([{
        runKey: ORIGINAL_SLOT, source: schedule.type === "cron" ? "catchup" : "once", status: "triggered",
      }]);
    }
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ postponed: 2, pending: 0 });
  });

  it.each(["completed", "cancelled"] as const)("recovers protected slots when a %s window was never observed by a running scheduler", async (status) => {
    const ctx = fixture();
    const window = ctx.protect();
    const schedules = [ctx.createSchedule("once"), ctx.createSchedule("cron")];
    if (status === "cancelled") {
      vi.setSystemTime("2026-09-05T10:15:00.000Z");
      ctx.focusProtectionStore.cancel(window.id);
    }
    expect(ctx.focusProtectionStore.outstanding("schedule")).toEqual([]);
    vi.setSystemTime("2026-09-05T13:00:00.000Z");
    await ctx.start();

    expect(ctx.manager.startWork).toHaveBeenCalledTimes(2);
    for (const schedule of schedules) {
      expect(ctx.claims(schedule.id)[0]).toMatchObject({ runKey: ORIGINAL_SLOT, status: "triggered" });
    }
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ postponed: 2, pending: 0 });
  });

  it("keeps the original cron cursor beyond the normal 24-hour cron-trigger lookback", async () => {
    const ctx = fixture();
    ctx.protect("2026-09-07T10:00:00.000Z");
    const schedule = ctx.createSchedule("cron");
    await ctx.start();
    vi.setSystemTime("2026-09-06T11:00:00.000Z");
    expect(scheduler.getCronTriggerScheduledFor(schedule.id)).toBe(ORIGINAL_SLOT);
    state.cronTicks[0]();
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.focusProtectionStore.outstanding("schedule")).toHaveLength(1);
    expect(ctx.claims(schedule.id)).toEqual([]);
  });

  it("recovers all outstanding holds without an attention-list cap or a due-cursor dependency", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const slot = "2026-09-05T08:00:00.000Z";
    for (let index = 0; index < 501; index++) {
      const schedule = ctx.createSchedule("once", slot);
      ctx.scheduleStore.updateNextRunAt(schedule.id, "2026-09-06T00:00:00.000Z");
      ctx.focusProtectionStore.hold(window, { kind: "schedule", workId: schedule.id, scheduledFor: slot });
    }
    vi.setSystemTime("2026-09-05T13:00:00.000Z");
    expect(ctx.scheduleStore.listDueSchedules(new Date().toISOString())).toEqual([]);
    expect(ctx.focusProtectionStore.coveringSlot(slot)).toBeNull();
    const triggerSchedule = vi.fn(async (
      _id: string,
      _options: { source: "once" | "catchup"; scheduledFor: string },
    ) => ({ skipped: "Restart pending" }));
    const controller = createMissedRunCatchUpController({
      scheduleStore: () => ctx.scheduleStore,
      computeNextRunAt: scheduler.computeNextRunAt,
      unregisterSchedule: vi.fn(),
      triggerSchedule,
      isRestartPending: () => false,
      refreshRestartState: async () => ({
        requestId: null, phase: "idle", requestedAt: null, waitingSessions: 0,
        launcherHeartbeatAt: null, releaseFailure: null,
      }),
      getRestartPendingMessage: () => "Restart pending",
      focusProtectionStore: () => ctx.focusProtectionStore,
    });
    controllers.push(controller);
    controller.check();
    await controller.waitForIdle();

    expect(triggerSchedule).toHaveBeenCalledTimes(501);
    expect(triggerSchedule.mock.calls.every(([, options]) => options.scheduledFor === slot)).toBe(true);
    vi.setSystemTime("2026-09-08T13:00:00.000Z");
    controller.check();
    await controller.waitForIdle();
    expect(triggerSchedule).toHaveBeenCalledTimes(1_002);
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({
      postponed: 501, pending: 501, dispositions: {},
    });
  });

  it.each([
    ["expired", "expired"],
    ["disabled", "cancelled"],
    ["deleted", "cancelled"],
    ["rescheduled-once", "superseded"],
    ["rescheduled-cron", "superseded"],
    ["already-ran", "no-longer-needed"],
  ] as const)("settles %s work changed while offline without replaying its held slot", async (change, disposition) => {
    const ctx = fixture();
    const window = ctx.protect();
    const schedule = ctx.createSchedule(change === "rescheduled-cron" ? "cron" : "once");
    await ctx.start();
    expect(ctx.focusProtectionStore.outstanding("schedule")).toHaveLength(1);
    scheduler.shutdown();
    switch (change) {
      case "expired": ctx.scheduleStore.updateSchedule(schedule.id, { expiresAt: "2026-09-05T10:30:00.000Z" }); break;
      case "disabled": ctx.scheduleStore.updateSchedule(schedule.id, { enabled: false }); break;
      case "deleted": ctx.scheduleStore.deleteSchedule(schedule.id); break;
      case "rescheduled-once": ctx.scheduleStore.updateSchedule(schedule.id, { runAt: "2026-09-05T14:00:00.000Z" }); break;
      case "rescheduled-cron": ctx.scheduleStore.updateSchedule(schedule.id, { cron: "*/15 * * * *" }); break;
      case "already-ran": ctx.scheduleStore.recordRun(schedule.id, "manual-while-offline"); break;
    }
    vi.setSystemTime("2026-09-05T13:00:00.000Z");
    await ctx.start();

    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({
      postponed: 1, pending: 0, dispositions: { [disposition]: 1 },
    });
    expect(ctx.claims(schedule.id)).toEqual([]);
  });

  it("does not mistake a name or prompt update for a reschedule", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const schedule = ctx.createSchedule("cron");
    await ctx.start();
    scheduler.shutdown();
    ctx.scheduleStore.updateSchedule(schedule.id, { name: "Renamed", prompt: "Updated prompt" });
    vi.setSystemTime("2026-09-05T13:00:00.000Z");
    await ctx.start();
    expect(ctx.manager.startWork).toHaveBeenCalledWith("protected-session-1", "Updated prompt");
    expect(ctx.focusProtectionStore.impacts(window.id).dispositions).toEqual({ started: 1 });
  });
});

describe("protected retry ownership", () => {
  it("keeps a held slot pending through capacity pressure until it is actually accepted", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const schedule = ctx.createSchedule("once");
    await ctx.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctx.manager.createTaskSession.mockImplementation(async (...args: unknown[]) => {
      const name = (args[6] as { name: string }).name;
      if (name.startsWith("blocker")) await gate;
      return { sessionId: `session-${name}` };
    });
    const blockers = [1, 2, 3].map((index) => ctx.createSchedule("cron", "2026-09-05T14:00:00.000Z", { name: `blocker-${index}` }));
    const runs = blockers.map((blocker) => scheduler.triggerSchedule(blocker.id));
    ctx.focusProtectionStore.cancel(window.id);
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ pending: 1, dispositions: {} });
    expect(ctx.claims(schedule.id)).toEqual([]);
    release();
    await Promise.all(runs);
    await scheduler.waitForMissedRunCatchUpForTests();
    await vi.advanceTimersByTimeAsync(30_000);
    await scheduler.waitForMissedRunCatchUpForTests();

    expect(ctx.manager.startWork.mock.calls.filter((call) => call[0] === `session-${schedule.name}`)).toHaveLength(1);
    expect(ctx.claims(schedule.id)).toEqual([{ runKey: ORIGINAL_SLOT, source: "once", status: "triggered" }]);
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { started: 1 } });
  });

  it("retains protected eligibility through rate limiting and retries using execution time without changing the run key", async () => {
    const ctx = fixture();
    const window = ctx.protect("2026-09-05T10:02:00.000Z");
    const slot = "2026-09-05T10:01:00.000Z";
    const schedule = ctx.createSchedule("cron", slot, { cron: "* * * * *" });
    ctx.scheduleStore.recordRun(schedule.id, "previous-run", slot);
    await ctx.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot });
    await vi.advanceTimersByTimeAsync(63_001);
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ pending: 1, dispositions: {} });
    expect(ctx.claims(schedule.id)).toEqual([]);
    await vi.advanceTimersByTimeAsync(Date.parse("2026-09-05T10:05:00.000Z") - Date.now());
    await scheduler.waitForMissedRunCatchUpForTests();

    expect(ctx.manager.startWork).toHaveBeenCalledOnce();
    expect(ctx.claims(schedule.id)).toEqual([{ runKey: slot, source: "cron", status: "triggered" }]);
    expect(ctx.focusProtectionStore.impacts(window.id).dispositions).toEqual({ started: 1 });
  });

  it("keeps unresolved holds through a long restart and a transient launch failure after protection expires", async () => {
    const ctx = fixture();
    const window = ctx.protect();
    const schedule = ctx.createSchedule("once");
    await ctx.start();
    state.phase = "restarting";
    state.requestedAt = START;
    vi.setSystemTime("2026-09-05T14:00:00.000Z");
    ctx.globalBus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.manager.startWork).not.toHaveBeenCalled();
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ pending: 1, dispositions: {} });

    state.phase = "idle";
    ctx.manager.createTaskSession.mockRejectedValueOnce(new Error("Temporary capacity failure"));
    ctx.globalBus.emit({ type: "server:restart-cleared" });
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.claims(schedule.id)).toEqual([]);
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.enabled).toBe(true);
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ pending: 1, dispositions: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    await scheduler.waitForMissedRunCatchUpForTests();
    expect(ctx.manager.startWork).toHaveBeenCalledOnce();
    expect(ctx.claims(schedule.id)).toEqual([{ runKey: ORIGINAL_SLOT, source: "once", status: "triggered" }]);
    expect(ctx.focusProtectionStore.impacts(window.id).dispositions).toEqual({ started: 1 });
  });
});
