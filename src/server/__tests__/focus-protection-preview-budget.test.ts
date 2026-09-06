import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cron from "../cron-next-run.js";
import { MAX_PROTECTION_CRON_PROBES, MAX_PROTECTION_CRON_PROBES_PER_SCHEDULE } from "../focus-protection-service.js";
import { FocusProtectionConflictError } from "../focus-protection-store.js";
import { createTestApp } from "./test-app.js";

const NOW = Date.parse("2026-09-05T12:01:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const request = {
  endsAt: at(7 * 24 * 60 * 60_000), timezone: "UTC", reason: "Seven-day bounded preview",
  allowNeedsInput: false, allowAuthorizedDeadlineOverride: false,
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const result = createTestApp();
  const task = result.ctx.taskStore.createTask("Preview cost");
  return {
    ...result,
    service: result.ctx.focusProtectionService!,
    createCron: (timezone = "UTC", maxRuns?: number) => result.ctx.scheduleStore.createSchedule({
      taskId: task.id, name: `Bounded ${timezone}`, prompt: "Check", type: "cron", cron: "*/5 * * * *", timezone, maxRuns,
    }),
    task,
  };
}

describe("protection preview work and transaction budgets", () => {
  it("bounds actual timezone probes for many schedules and performs no cron work under the write lock", () => {
    const { ctx, db, service, createCron } = fixture();
    const zones = ["America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Auckland"];
    for (let index = 0; index < 96; index++) createCron(zones[index % zones.length]);
    const format = Intl.DateTimeFormat.prototype.formatToParts;
    const duringWrite: boolean[] = [];
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (this: Intl.DateTimeFormat, date?: Date | number) {
      duringWrite.push(db.isTransaction);
      return format.call(this, date);
    });
    const preview = service.preview(request);
    expect(preview.schedules).toHaveLength(96);
    expect(preview.schedules.every((schedule) => schedule.slotCountComplete === false)).toBe(true);
    expect(preview.schedules.every((schedule) => schedule.slotsDue <= MAX_PROTECTION_CRON_PROBES_PER_SCHEDULE)).toBe(true);
    expect(duringWrite.length).toBeGreaterThan(0);
    expect(duringWrite.length).toBeLessThanOrEqual(MAX_PROTECTION_CRON_PROBES);
    expect(duringWrite.every((locked) => !locked)).toBe(true);

    duringWrite.length = 0;
    const sourceReadLocks: boolean[] = [];
    const read = ctx.scheduleStore.getEnabledSchedules;
    vi.spyOn(ctx.scheduleStore, "getEnabledSchedules").mockImplementation(() => {
      sourceReadLocks.push(db.isTransaction);
      return read();
    });
    const created = service.create({ ...preview.request, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: false });
    expect(created.status).toBe("active");
    expect(sourceReadLocks).toEqual([false, true]);
    expect(duringWrite.length).toBeLessThanOrEqual(MAX_PROTECTION_CRON_PROBES);
    expect(duringWrite.every((locked) => !locked)).toBe(true);
    expect(ctx.focusProtectionStore.list()).toHaveLength(1);
  });

  it("binds changes beyond a truncated prefix even when its displayed slot sample is unchanged", () => {
    const { ctx, service, createCron } = fixture();
    const schedule = createCron("America/Los_Angeles", 600);
    const before = service.preview(request);
    expect(before.schedules[0].slotCountComplete).toBe(false);
    ctx.scheduleStore.updateSchedule(schedule.id, { maxRuns: 800 });
    const after = service.preview(request);
    expect(after.schedules).toEqual(before.schedules);
    expect(after.confirmationToken).not.toBe(before.confirmationToken);
    const create = vi.spyOn(ctx.focusProtectionStore, "create");
    expect(() => service.create({ ...request, confirmationToken: before.confirmationToken, confirmInterventionConflicts: false }))
      .toThrow(FocusProtectionConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["schedule", "intervention", "input"] as const)("rejects a same-millisecond %s change during preparation", (kind) => {
    const { ctx, db, service, createCron } = fixture();
    const schedule = createCron();
    const preview = service.preview(request);
    const iterator = cron.createCronPreviewIterator;
    let changed = false;
    vi.spyOn(cron, "createCronPreviewIterator").mockImplementation((...args) => {
      expect(db.isTransaction).toBe(false);
      if (!changed) {
        changed = true;
        if (kind === "schedule") ctx.scheduleStore.updateSchedule(schedule.id, { maxRuns: 1 });
        else if (kind === "intervention") ctx.focusMutationCoordinator.saveDecision({
          title: "New time-critical choice", alternatives: ["Proceed", "Wait"], recommendation: "Wait",
          interventionBy: at(30_000), consequenceOfDelay: "The option expires",
        });
        else {
          vi.spyOn(ctx.sessionManager, "getPendingInputSessionIds").mockReturnValue(["new-input"]);
          vi.spyOn(ctx.sessionManager, "getPendingUserInputCount").mockReturnValue(1);
        }
      }
      return iterator(...args);
    });
    expect(() => service.create({ ...request, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: false }))
      .toThrow("Impacts changed during preparation");
    expect(Date.now()).toBe(NOW);
    expect(ctx.focusProtectionStore.list()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM focus_attention_events WHERE eventType='protection_created'").get()?.n).toBe(0);
  });

  it.each(["expiry", "lease", "catchup"] as const)("rejects sub-minute clock-only %s drift during preparation", (kind) => {
    const { ctx, service, createCron, task } = fixture();
    createCron();
    if (kind === "expiry") ctx.deferLoopStore!.create({
      sessionId: "parent", name: "Expires now", prompt: "Check", intervalSeconds: 300, nextRunAt: at(0), expiresAt: at(5),
    });
    else if (kind === "lease") {
      const prompt = ctx.deferredPromptStore!.create("parent", "In flight", at(-1_000));
      ctx.deferredPromptStore!.claimDue(prompt.id, 5);
    } else {
      ctx.scheduleStore.createSchedule({
        taskId: task.id, name: "Grace boundary", prompt: "Check", type: "once", runAt: at(-60 * 60_000 + 5),
      });
    }
    const preview = service.preview(request);
    const iterator = cron.createCronPreviewIterator;
    vi.spyOn(cron, "createCronPreviewIterator").mockImplementation((...args) => {
      vi.setSystemTime(NOW + 10);
      return iterator(...args);
    });
    expect(() => service.create({ ...request, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: false }))
      .toThrow("Impacts changed during preparation");
    expect(ctx.focusProtectionStore.list()).toHaveLength(0);
  });
});
