import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createScheduleStore } from "../schedule-store.js";
import type { ScheduleStore } from "../schedule-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: ScheduleStore;

beforeEach(() => {
  db = setupTestDb();
  store = createScheduleStore(db);
});

describe("schedule-store", () => {
  const baseCron = {
    taskId: "task-1",
    name: "Daily standup",
    prompt: "Prep standup notes",
    type: "cron" as const,
    cron: "0 8 * * 1-5",
  };

  describe("CRUD", () => {
    it("listSchedules returns empty when no file", () => {
      expect(store.listSchedules()).toEqual([]);
    });

    it("createSchedule returns a valid schedule", () => {
      const s = store.createSchedule(baseCron);
      expect(s.id).toBeTruthy();
      expect(s.name).toBe("Daily standup");
      expect(s.enabled).toBe(true);
      expect(s.runCount).toBe(0);
      expect(s.sessionMode).toBe("new");
    });

    it("getSchedule returns created schedule", () => {
      const s = store.createSchedule(baseCron);
      expect(store.getSchedule(s.id)).toBeDefined();
      expect(store.getSchedule(s.id)!.name).toBe("Daily standup");
    });

    it("getSchedule returns undefined for missing id", () => {
      expect(store.getSchedule("nope")).toBeUndefined();
    });

    it("listSchedules filters by taskId", () => {
      store.createSchedule(baseCron);
      store.createSchedule({ ...baseCron, taskId: "task-2", name: "Other" });
      expect(store.listSchedules("task-1")).toHaveLength(1);
      expect(store.listSchedules("task-2")).toHaveLength(1);
      expect(store.listSchedules()).toHaveLength(2);
    });

    it("updateSchedule changes fields", () => {
      const s = store.createSchedule(baseCron);
      const updated = store.updateSchedule(s.id, { name: "Renamed", enabled: false, sessionMode: "reuse-last" });
      expect(updated.name).toBe("Renamed");
      expect(updated.enabled).toBe(false);
      expect(updated.sessionMode).toBe("reuse-last");
    });

    it("normalizes legacy reuse-target rows to reuse-last without exposing targets", () => {
      const s = store.createSchedule(baseCron);
      db.prepare("UPDATE schedules SET sessionMode = ?, targetSessionId = ? WHERE id = ?")
        .run("reuse-target", "session-123", s.id);
      const hydrated = store.getSchedule(s.id)!;
      expect(hydrated.sessionMode).toBe("reuse-last");
      expect(hydrated.lastSessionId).toBe("session-123");
      expect(store.requiresExistingReuseSession(s.id)).toBe(true);
      expect((hydrated as any).targetSessionId).toBeUndefined();
    });

    it("explicit sessionMode update clears migrated reuse-target strictness", () => {
      const s = store.createSchedule({ ...baseCron, sessionMode: "reuse-last" });
      db.prepare("UPDATE schedules SET lastSessionId = ?, reuseLastRequiresExistingSession = 1 WHERE id = ?")
        .run("session-123", s.id);

      expect(store.requiresExistingReuseSession(s.id)).toBe(true);
      const renamed = store.updateSchedule(s.id, { name: "Still strict" });
      expect(renamed.sessionMode).toBe("reuse-last");
      expect(store.requiresExistingReuseSession(s.id)).toBe(true);

      const updated = store.updateSchedule(s.id, { sessionMode: "reuse-last" });
      expect(updated.sessionMode).toBe("reuse-last");
      expect(store.requiresExistingReuseSession(s.id)).toBe(false);
    });

    it("updateSchedule throws for missing id", () => {
      expect(() => store.updateSchedule("nope", { name: "x" })).toThrow("not found");
    });

    it("deleteSchedule removes the schedule", () => {
      const s = store.createSchedule(baseCron);
      db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
        .run(s.id, "session-1", "2026-01-01T00:00:00.000Z");
      store.claimAutomaticRun(s.id, "2026-01-01T08:00:00.000Z", "cron", "2026-01-01T08:00:00.000Z");
      store.deleteSchedule(s.id);
      expect(store.getSchedule(s.id)).toBeUndefined();
      expect(store.listSchedules()).toHaveLength(0);
      const runs = db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE scheduleId = ?").get(s.id) as { count: number };
      expect(runs.count).toBe(0);
      const claims = db.prepare("SELECT COUNT(*) AS count FROM schedule_run_claims WHERE scheduleId = ?").get(s.id) as { count: number };
      expect(claims.count).toBe(0);
    });
  });

  describe("run tracking", () => {
    it("recordRun increments runCount and sets lastRunAt", () => {
      const s = store.createSchedule(baseCron);
      store.recordRun(s.id, "session-abc");
      const updated = store.getSchedule(s.id)!;
      expect(updated.runCount).toBe(1);
      expect(updated.lastRunAt).toBeTruthy();
      expect(updated.lastSessionId).toBe("session-abc");
    });

    it("recordRun auto-disables one-shot schedule", () => {
      const s = store.createSchedule({
        taskId: "task-1",
        name: "Once",
        prompt: "do it",
        type: "once",
        runAt: new Date().toISOString(),
      });
      store.recordRun(s.id, "session-xyz");
      expect(store.getSchedule(s.id)!.enabled).toBe(false);
    });

    it("recordRun auto-disables when maxRuns reached", () => {
      const s = store.createSchedule({ ...baseCron, maxRuns: 2 });
      store.recordRun(s.id, "s1");
      expect(store.getSchedule(s.id)!.enabled).toBe(true);
      store.recordRun(s.id, "s2");
      expect(store.getSchedule(s.id)!.enabled).toBe(false);
    });

    it("recordRun is no-op for missing schedule", () => {
      expect(() => store.recordRun("nope", "s1")).not.toThrow();
    });
  });

  describe("automatic run claims", () => {
    it("dedupes automatic runs by scheduled slot and reclaims stale claims", () => {
      const s = store.createSchedule(baseCron);
      const runKey = "2026-01-01T08:00:00.000Z";

      expect(store.claimAutomaticRun(s.id, runKey, "cron", "2026-01-01T08:00:00.000Z")).toMatchObject({
        acquired: true,
        claim: { runKey },
      });
      expect(store.claimAutomaticRun(s.id, runKey, "cron", "2026-01-01T08:01:00.000Z")).toMatchObject({
        acquired: false,
      });
      expect(store.claimAutomaticRun(s.id, runKey, "cron", "2026-01-01T08:03:00.000Z")).toMatchObject({
        acquired: true,
        claim: { runKey },
      });
    });

    it("completeAutomaticRun records the run and finalizes the claim", () => {
      const s = store.createSchedule(baseCron);
      const runKey = "2026-01-01T08:00:00.000Z";

      const claimed = store.claimAutomaticRun(s.id, runKey, "cron", runKey);
      expect(claimed.acquired).toBe(true);
      if (!claimed.acquired) {
        throw new Error("expected claim to be acquired");
      }
      expect(store.completeAutomaticRun(s.id, claimed.claim, "session-abc")).toBe(true);

      expect(store.getSchedule(s.id)).toMatchObject({
        runCount: 1,
        lastSessionId: "session-abc",
      });
      const claim = db.prepare(
        "SELECT status, sessionId FROM schedule_run_claims WHERE scheduleId = ? AND runKey = ?",
      ).get(s.id, runKey) as { status: string; sessionId: string | null };
      expect(claim).toEqual({ status: "triggered", sessionId: "session-abc" });
    });

    it("ignores stale finalization from a reclaimed automatic claim", () => {
      const s = store.createSchedule(baseCron);
      const runKey = "2026-01-01T08:00:00.000Z";
      const firstClaim = store.claimAutomaticRun(s.id, runKey, "cron", "2026-01-01T08:00:00.000Z");
      const secondClaim = store.claimAutomaticRun(s.id, runKey, "cron", "2026-01-01T08:03:00.000Z");
      expect(firstClaim.acquired).toBe(true);
      expect(secondClaim.acquired).toBe(true);
      if (!firstClaim.acquired || !secondClaim.acquired) {
        throw new Error("expected both claims to be acquired");
      }

      expect(store.completeAutomaticRun(s.id, firstClaim.claim, "session-a")).toBe(false);
      expect(store.getSchedule(s.id)).toMatchObject({
        runCount: 0,
        lastSessionId: undefined,
      });

      expect(store.completeAutomaticRun(s.id, secondClaim.claim, "session-b")).toBe(true);
      expect(store.getSchedule(s.id)).toMatchObject({
        runCount: 1,
        lastSessionId: "session-b",
      });
      const claim = db.prepare(
        "SELECT status, sessionId FROM schedule_run_claims WHERE scheduleId = ? AND runKey = ?",
      ).get(s.id, runKey) as { status: string; sessionId: string | null };
      expect(claim).toEqual({ status: "triggered", sessionId: "session-b" });
    });

    it("skips and disables one-shot automatic claims durably", () => {
      const s = store.createSchedule({
        taskId: "task-1",
        name: "One-shot",
        prompt: "do it once",
        type: "once",
        runAt: "2026-01-01T08:00:00.000Z",
      });
      const runKey = "2026-01-01T08:00:00.000Z";

      const claimed = store.claimAutomaticRun(s.id, runKey, "once", runKey);
      expect(claimed.acquired).toBe(true);
      if (!claimed.acquired) {
        throw new Error("expected claim to be acquired");
      }

      expect(store.skipAutomaticRun(s.id, claimed.claim)).toBe(true);
      expect(store.getSchedule(s.id)).toMatchObject({
        enabled: false,
        runCount: 0,
        nextRunAt: undefined,
      });
      const claim = db.prepare(
        "SELECT status, sessionId FROM schedule_run_claims WHERE scheduleId = ? AND runKey = ?",
      ).get(s.id, runKey) as { status: string; sessionId: string | null };
      expect(claim).toEqual({ status: "skipped", sessionId: null });
    });

    it("serializes per-schedule run claims until they are released", () => {
      const s = store.createSchedule(baseCron);

      const firstClaim = store.claimScheduleRun(s.id, "manual", "2026-01-01T08:00:00.000Z");
      const secondClaim = store.claimScheduleRun(s.id, "cron", "2026-01-01T08:00:01.000Z");
      expect(firstClaim.acquired).toBe(true);
      expect(secondClaim).toMatchObject({ acquired: false });
      if (!firstClaim.acquired) {
        throw new Error("expected first schedule claim to be acquired");
      }

      expect(store.releaseClaimedAutomaticRun(s.id, firstClaim.claim)).toBe(true);
      expect(store.claimScheduleRun(s.id, "cron", "2026-01-01T08:00:02.000Z")).toMatchObject({
        acquired: true,
      });
    });

    it("renews an owned automatic claim lease", () => {
      const s = store.createSchedule(baseCron);
      const runKey = "2026-01-01T08:00:00.000Z";
      const claimed = store.claimAutomaticRun(s.id, runKey, "cron", "2026-01-01T08:00:00.000Z");
      expect(claimed.acquired).toBe(true);
      if (!claimed.acquired) {
        throw new Error("expected claim to be acquired");
      }

      const priorLease = claimed.claim.leaseExpiresAt;
      expect(store.renewClaimedAutomaticRun(s.id, claimed.claim, "2026-01-01T08:01:30.000Z")).toBe(true);
      expect(claimed.claim.leaseExpiresAt).not.toBe(priorLease);
      expect(store.claimAutomaticRun(s.id, runKey, "cron", "2026-01-01T08:02:00.000Z")).toMatchObject({
        acquired: false,
      });
    });

    it("serializes reused-session claims across schedules until released", () => {
      const first = store.createSchedule(baseCron);
      const second = store.createSchedule({ ...baseCron, taskId: "task-2", name: "Other schedule" });

      const firstClaim = store.claimSessionReuse("shared-session", first.id, "2026-01-01T08:00:00.000Z");
      const secondClaim = store.claimSessionReuse("shared-session", second.id, "2026-01-01T08:00:01.000Z");
      expect(firstClaim.acquired).toBe(true);
      expect(secondClaim).toMatchObject({ acquired: false });
      if (!firstClaim.acquired) {
        throw new Error("expected first session reuse claim to be acquired");
      }

      expect(store.releaseClaimedSessionReuse("shared-session", firstClaim.claim)).toBe(true);
      expect(store.claimSessionReuse("shared-session", second.id, "2026-01-01T08:00:02.000Z")).toMatchObject({
        acquired: true,
      });
    });
  });

  describe("helpers", () => {
    it("getSchedulesForTask returns filtered list", () => {
      store.createSchedule(baseCron);
      store.createSchedule({ ...baseCron, taskId: "other" });
      expect(store.getSchedulesForTask("task-1")).toHaveLength(1);
    });

    it("getEnabledSchedules filters disabled", () => {
      const s1 = store.createSchedule(baseCron);
      store.createSchedule(baseCron);
      store.updateSchedule(s1.id, { enabled: false });
      expect(store.getEnabledSchedules()).toHaveLength(1);
    });
  });
});
