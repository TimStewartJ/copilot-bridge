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
      expect(s.targetSessionId).toBeUndefined();
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

    it("stores target sessions for reuse-target mode", () => {
      const s = store.createSchedule({ ...baseCron, sessionMode: "reuse-target", targetSessionId: "session-123" });
      expect(s.sessionMode).toBe("reuse-target");
      expect(s.targetSessionId).toBe("session-123");

      const updated = store.updateSchedule(s.id, { sessionMode: "new" });
      expect(updated.sessionMode).toBe("new");
      expect(updated.targetSessionId).toBeUndefined();
    });

    it("updateSchedule throws for missing id", () => {
      expect(() => store.updateSchedule("nope", { name: "x" })).toThrow("not found");
    });

    it("deleteSchedule removes the schedule", () => {
      const s = store.createSchedule(baseCron);
      db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
        .run(s.id, "session-1", "2026-01-01T00:00:00.000Z");
      store.deleteSchedule(s.id);
      expect(store.getSchedule(s.id)).toBeUndefined();
      expect(store.listSchedules()).toHaveLength(0);
      const runs = db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE scheduleId = ?").get(s.id) as { count: number };
      expect(runs.count).toBe(0);
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
