import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setupTestDb } from "./helpers.js";
import { createScheduleStore } from "../schedule-store.js";
import type { ScheduleStore } from "../schedule-store.js";
import { openDatabase, type DatabaseSync as BridgeDatabaseSync } from "../db.js";

let db: BridgeDatabaseSync;
let store: ScheduleStore;

beforeEach(() => {
  db = setupTestDb();
  store = createScheduleStore(db);
});

afterEach(() => {
  db.close();
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
      const s = store.createSchedule({
        ...baseCron,
        model: "claude-sonnet-5",
        autoArchiveKeep: 8,
      });
      expect(s.id).toBeTruthy();
      expect(s.name).toBe("Daily standup");
      expect(s.enabled).toBe(true);
      expect(s.runCount).toBe(0);
      expect(s.model).toBe("claude-sonnet-5");
      expect(s.autoArchiveKeep).toBe(8);
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

    it("listDueSchedules returns only enabled schedules with due nextRunAt values", () => {
      const dueEarly = store.createSchedule({ ...baseCron, name: "Due early" });
      const dueLate = store.createSchedule({ ...baseCron, name: "Due late" });
      const future = store.createSchedule({ ...baseCron, name: "Future" });
      const missingNextRun = store.createSchedule({ ...baseCron, name: "Missing next run" });
      const disabled = store.createSchedule({ ...baseCron, name: "Disabled" });

      store.updateNextRunAt(dueLate.id, "2026-01-01T08:00:00Z");
      store.updateNextRunAt(dueEarly.id, "2026-01-01T07:00:00.000Z");
      store.updateNextRunAt(future.id, "2026-01-01T09:00:00.000Z");
      store.updateNextRunAt(disabled.id, "2026-01-01T07:30:00.000Z");
      store.updateSchedule(disabled.id, { enabled: false });

      expect(store.listDueSchedules("2026-01-01T08:30:00.000Z").map((item) => item.id)).toEqual([
        dueEarly.id,
        dueLate.id,
      ]);
      expect(store.getSchedule(dueLate.id)?.nextRunAt).toBe("2026-01-01T08:00:00.000Z");
      expect(store.listDueSchedules("2026-01-01T08:30:00.000Z").map((item) => item.id)).not.toContain(missingNextRun.id);
    });

    it("updateSchedule changes fields", () => {
      const s = store.createSchedule(baseCron);
      const updated = store.updateSchedule(s.id, { name: "Renamed", enabled: false });
      expect(updated.name).toBe("Renamed");
      expect(updated.enabled).toBe(false);
    });

    it("updateSchedule changes and clears autoArchiveKeep", () => {
      const s = store.createSchedule(baseCron);
      expect(store.updateSchedule(s.id, { autoArchiveKeep: 4 }).autoArchiveKeep).toBe(4);
      expect(store.updateSchedule(s.id, { autoArchiveKeep: null }).autoArchiveKeep).toBeUndefined();
    });

    it("updateSchedule changes and clears the model override", () => {
      const s = store.createSchedule(baseCron);
      expect(store.updateSchedule(s.id, { model: "gpt-5.6-sol" }).model).toBe("gpt-5.6-sol");
      expect(store.updateSchedule(s.id, { model: null }).model).toBeUndefined();
    });

    it("removes legacy reuse schema while preserving run history during database migration", () => {
      const dataDir = mkdtempSync(join(process.cwd(), ".schedule-migration-"));
      try {
        const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
        legacyDb.exec(`
          CREATE TABLE schedules (
            id TEXT PRIMARY KEY,
            taskId TEXT NOT NULL,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            type TEXT NOT NULL,
            cron TEXT,
            runAt TEXT,
            timezone TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            sessionMode TEXT NOT NULL DEFAULT 'new',
            targetSessionId TEXT,
            lastSessionId TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            lastRunAt TEXT,
            nextRunAt TEXT,
            runCount INTEGER NOT NULL DEFAULT 0,
            maxRuns INTEGER,
            expiresAt TEXT
          );
          CREATE TABLE schedule_session_claims (
            sessionId TEXT PRIMARY KEY,
            scheduleId TEXT NOT NULL,
            claimedAt TEXT NOT NULL,
            leaseExpiresAt TEXT NOT NULL
          );
        `);
        const now = "2026-01-01T00:00:00.000Z";
        legacyDb.prepare(`
          INSERT INTO schedules (
            id, taskId, name, prompt, type, cron, enabled, sessionMode, targetSessionId,
            lastSessionId, createdAt, updatedAt, runCount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "reuse-target-schedule", "task-1", "Legacy target", "Run target", "cron", "0 8 * * *", 1,
          "reuse-target", "target-session", null, now, now, 0,
        );
        legacyDb.prepare(`
          INSERT INTO schedules (
            id, taskId, name, prompt, type, cron, enabled, sessionMode, targetSessionId,
            lastSessionId, createdAt, updatedAt, runCount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "reuse-last-schedule", "task-1", "Legacy last", "Run last", "cron", "0 9 * * *", 1,
          "reuse-last", null, "last-session", now, now, 3,
        );
        legacyDb.prepare(`
          INSERT INTO schedule_session_claims (sessionId, scheduleId, claimedAt, leaseExpiresAt)
          VALUES (?, ?, ?, ?)
        `).run("last-session", "reuse-last-schedule", now, "2026-01-01T00:02:00.000Z");
        legacyDb.close();

        const migratedDb = openDatabase(dataDir);
        try {
          const rows = migratedDb.prepare(`
            SELECT id, model, autoArchiveKeep, lastSessionId
            FROM schedules
            ORDER BY id
          `).all() as Array<{
            id: string;
            model: string | null;
            autoArchiveKeep: number | null;
            lastSessionId: string | null;
          }>;
          expect(rows).toEqual([
            {
              id: "reuse-last-schedule",
              model: null,
              autoArchiveKeep: null,
              lastSessionId: "last-session",
            },
            {
              id: "reuse-target-schedule",
              model: null,
              autoArchiveKeep: null,
              lastSessionId: "target-session",
            },
          ]);

          const scheduleColumns = (migratedDb.prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string }>)
            .map((column) => column.name);
          expect(scheduleColumns).not.toContain("sessionMode");
          expect(scheduleColumns).not.toContain("targetSessionId");
          expect(scheduleColumns).not.toContain("reuseLastRequiresExistingSession");
          expect(scheduleColumns).toContain("autoArchiveKeep");
          expect(scheduleColumns).toContain("model");
          const claimsTable = migratedDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule_session_claims'").get();
          expect(claimsTable).toBeUndefined();
          const runs = migratedDb.prepare(`
            SELECT scheduleId, sessionId
            FROM schedule_runs
            ORDER BY scheduleId, sessionId
          `).all();
          expect(runs).toEqual([
            { scheduleId: "reuse-last-schedule", sessionId: "last-session" },
            { scheduleId: "reuse-target-schedule", sessionId: "target-session" },
          ]);
        } finally {
          migratedDb.close();
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
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
