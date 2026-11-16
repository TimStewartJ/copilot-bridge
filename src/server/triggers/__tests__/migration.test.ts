import { describe, expect, it } from "vitest";
import { setupTestDb } from "../../__tests__/helpers.js";
import { migrateToTriggersOnce } from "../migration.js";
import { createTriggerStore } from "../store.js";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const at = "2026-11-10T00:00:00.000Z";

function seedLegacyRows() {
  const db = setupTestDb();
  // openDatabase already ran the migration on the empty database; this one starts over.
  db.prepare("DELETE FROM settings WHERE key = 'migration:triggers'").run();
  db.prepare(`INSERT INTO defer_loops (id, sessionId, name, prompt, intervalSeconds, nextRunAt, status, runCount, maxRuns,
    expiresAt, attempts, createdAt, updatedAt, checkpoint, checkSpec, checkFingerprint, checkOutput, lastCheckAt, lastCheckOutcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "loop-1", "chat-1", "PR watch", "Watch the PR", 600, "2026-11-16T12:05:00.000Z", "active", 4, null,
    "2026-11-20T00:00:00.000Z", 0, at, at, JSON.stringify({ seen: 3 }),
    JSON.stringify({ command: ["gh", "pr", "view"], timeoutSeconds: 60, wakeOnFirstRun: true }), "fp-1",
    JSON.stringify({ exitCode: 0, stdout: "open", stderr: "" }), at, "unchanged",
  );
  db.prepare(`INSERT INTO defer_loops (id, sessionId, prompt, intervalSeconds, nextRunAt, status, runCount, attempts, createdAt, updatedAt)
    VALUES ('loop-done', 'chat-1', 'Old', 600, ?, 'completed', 9, 0, ?, ?)`).run(at, at, at);
  const prompt = db.prepare(`INSERT INTO deferred_prompts (id, sessionId, prompt, purpose, runAt, status, attempts, createdAt, updatedAt)
    VALUES (?, 'chat-2', ?, ?, ?, ?, 0, ?, ?)`);
  prompt.run("once-1", "Check the deploy", "defer", "2026-11-16T13:00:00.000Z", "pending", at, at);
  prompt.run("restart-1", "<bridge_notice>\nThe Bridge restarted\n</bridge_notice>", "defer", at, "pending", at, at);
  prompt.run("delivery-1", "<deferred-work-result>…", "delivery", at, "pending", at, at);
  db.prepare("INSERT INTO tasks (id, title, kind, status, notes, priority, \"order\", createdAt, updatedAt) VALUES ('task-1', 'Ops', 'task', 'active', '', 0, 0, ?, ?)").run(at, at);
  const schedule = db.prepare(`INSERT INTO schedules (id, taskId, name, prompt, type, cron, runAt, timezone, enabled, lastSessionId,
    createdAt, updatedAt, lastRunAt, nextRunAt, runCount, maxRuns, expiresAt, autoArchiveKeep, modelTier, playbook)
    VALUES (?, 'task-1', ?, ?, ?, ?, ?, 'America/Los_Angeles', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`);
  schedule.run("sched-cron", "Morning sweep", "Sweep", "cron", "0 8 * * 1-5", null, 1, "chat-9", at, at, at, "2026-11-17T16:00:00.000Z", 12, 5, "preset2", "sweep");
  schedule.run("sched-paused", "Paused", "Later", "cron", "0 9 * * *", null, 0, null, at, at, null, null, 0, null, null, null);
  schedule.run("sched-once-ran", "Once", "One time", "once", null, "2026-11-12T00:00:00.000Z", 0, "chat-8", at, at, at, null, 1, null, null, null);
  db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES ('sched-cron', 'chat-9', ?)").run(at);
  return db;
}

describe("migrateToTriggersOnce", () => {
  it("moves live defers, every schedule and its runs to triggers with their ids, and retires the old rows", () => {
    const db = seedLegacyRows();
    expect(migrateToTriggersOnce(db, NOW)).toEqual({ loops: 1, oneShots: 1, schedules: 3, runs: 1 });
    const store = createTriggerStore(db);

    expect(store.get("loop-1")).toMatchObject({
      name: "PR watch", sessionId: "chat-1", status: "active", runCount: 4,
      when: { kind: "every", seconds: 600 }, action: { kind: "chat", via: "worker" },
      check: { command: ["gh", "pr", "view"], fireOn: "change", fireOnFirstRun: true },
      lastCheck: { outcome: "unchanged", fingerprint: "fp-1", output: { stdout: "open" } },
      checkpoint: { seen: 3 }, expiresAt: "2026-11-20T00:00:00.000Z",
    });
    expect(store.get("loop-done")).toBeUndefined();
    expect(store.get("once-1")).toMatchObject({ sessionId: "chat-2", when: { kind: "at", at: "2026-11-16T13:00:00.000Z" }, status: "active" });
    expect(store.get("restart-1")).toBeUndefined();
    expect(store.get("sched-cron")).toMatchObject({
      taskId: "task-1", status: "active", runCount: 12, fireCount: 12, lastSessionId: "chat-9",
      when: { kind: "cron", cron: "0 8 * * 1-5", timezone: "America/Los_Angeles" },
      action: { kind: "new_chat", modelTier: "preset2", playbook: "sweep", keepChats: 5 },
    });
    expect(store.get("sched-paused")).toMatchObject({ status: "paused" });
    expect(store.get("sched-once-ran")).toMatchObject({ status: "completed", when: { kind: "at" } });
    expect(store.listRuns("sched-cron").runs).toMatchObject([{ sessionId: "chat-9" }]);

    // An older release opening this database finds nothing left to run.
    expect(db.prepare("SELECT status FROM defer_loops WHERE id = 'loop-1'").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM deferred_prompts WHERE id = 'once-1'").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM deferred_prompts WHERE id IN ('restart-1', 'delivery-1')").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1").get()).toEqual({ n: 0 });

    expect(migrateToTriggersOnce(db, NOW)).toBeUndefined();
  });
});
