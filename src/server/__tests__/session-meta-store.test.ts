import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSessionMetaStore, resolveScheduleRunsKeep, DEFAULT_SCHEDULE_RUNS_KEEP } from "../session-meta-store.js";
import type { SessionMetaStore } from "../session-meta-store.js";
import type { DatabaseSync } from "../db.js";
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";

let db: DatabaseSync;
let store: SessionMetaStore;

beforeEach(() => {
  db = setupTestDb();
  store = createSessionMetaStore(db);
});

describe("session-meta-store", () => {
  it("setArchived(false) preserves unrelated overlay fields", () => {
    const bridgeSessionState = createBridgeSessionStateStore(db);
    bridgeSessionState.setTitleOverride("session-1", "Manual title");

    store.setArchived("session-1", true);
    store.setArchived("session-1", false);

    expect(store.getMeta("session-1")).toBeUndefined();
    expect(bridgeSessionState.getState("session-1")?.titleOverride).toBe("Manual title");
  });

  it("setScheduleMeta preserves existing archive state", () => {
    store.setArchived("session-1", true);
    store.setScheduleMeta("session-1", "sched-1", "Test");
    const meta = store.getMeta("session-1");
    expect(meta).toMatchObject({ archived: true, triggeredBy: "schedule", scheduleId: "sched-1", scheduleName: "Test" });

    store.deleteMeta("session-1");
    expect(store.getMeta("session-1")).toBeUndefined();
  });

  it("listArchivedSessionIds returns ids of archived sessions only", () => {
    store.setArchived("archived", true);
    store.setArchived("restored", true);
    store.setArchived("restored", false);
    store.setLastVisibleActivityAt("active", "2026-05-07T21:00:00.000Z");

    store.setArchived("other", true);
    expect(store.listArchivedSessionIds().sort()).toEqual(["archived", "other"]);
    const meta = store.listMetaFor(["archived", "active", "no-row"]);

    expect(Object.keys(meta).sort()).toEqual(["active", "archived"]);
    expect(meta.archived).toMatchObject({ archived: true, archivedAt: expect.stringMatching(/^20/) });
    expect(meta.active).toMatchObject({ archived: false, archivedAt: "", lastVisibleActivityAt: "2026-05-07T21:00:00.000Z" });
    expect(meta["no-row"]).toBeUndefined();
    expect(store.listMetaFor([])).toEqual({});
  });

  it("lists attention metadata without exposing title-only or workspace-only overlays", () => {
    const overlays = createBridgeSessionStateStore(db);
    overlays.setTitleOverride("title-only", "Manual title");
    overlays.setPinnedCwd("workspace-only", "D:\\repo");
    store.setLastAttentionAt("attention-only", "2026-05-07T10:00:00.000Z");

    const attention = { archived: false, lastAttentionAt: "2026-05-07T10:00:00.000Z" };
    const all = store.listMeta();
    expect(Object.keys(all)).toEqual(["attention-only"]);
    expect(all["attention-only"]).toMatchObject(attention);
    expect(store.getMeta("attention-only")).toMatchObject(attention);
    expect(store.getMeta("title-only")).toBeUndefined();
    expect(store.getMeta("workspace-only")).toBeUndefined();
  });

  it("persists and clears bridge-synthesized terminal overlays", () => {
    store.setTerminalOverlay("session-1", {
      type: "aborted",
      runId: "run-1",
      turnId: "turn-1",
      timestamp: "2026-07-21T17:00:00.000Z",
      notice: { kind: "stopped", timestamp: "2026-07-21T17:00:00.000Z" },
    });

    expect(store.getTerminalOverlay("session-1")).toEqual({
      type: "aborted",
      runId: "run-1",
      turnId: "turn-1",
      timestamp: "2026-07-21T17:00:00.000Z",
      notice: { kind: "stopped", timestamp: "2026-07-21T17:00:00.000Z" },
    });
    expect(store.getMeta("session-1")?.terminalOverlay?.type).toBe("aborted");

    store.clearTerminalOverlay("session-1");
    expect(store.getTerminalOverlay("session-1")).toBeUndefined();
    expect(store.getMeta("session-1")).toBeUndefined();
  });

  it("returns only this schedule’s runs in chronological order across timestamp formats", () => {
    store.recordScheduleRun("sched-a", "repeated", "2026-01-01T00:00:00.000Z");
    store.recordScheduleRun("sched-a", "repeated", "2026-01-01T00:00:00.000Z");
    store.recordScheduleRun("sched-b", "other");
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run("sched-a", "later", "2026-01-01 23:00:00");

    const runs = store.listScheduleRuns("sched-a");
    expect(runs).toMatchObject([
      { sessionId: "later", recordedAt: "2026-01-01T23:00:00.000Z" },
      { sessionId: "repeated", recordedAt: "2026-01-01T00:00:00.000Z" },
      { sessionId: "repeated", recordedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(runs[1].id).toBeGreaterThan(runs[2].id);
    expect(store.listSessionIdsBySchedule("sched-a")).toEqual(["later", "repeated", "repeated"]);
  });

  it("run history is independent from latest session schedule metadata", () => {
    store.recordScheduleRun("sched-a", "shared");
    store.setScheduleMeta("shared", "sched-a", "Schedule A");
    store.recordScheduleRun("sched-b", "shared");
    store.setScheduleMeta("shared", "sched-b", "Schedule B");

    expect(store.listSessionIdsBySchedule("sched-a")).toEqual(["shared"]);
    expect(store.listSessionIdsBySchedule("sched-b")).toEqual(["shared"]);
    expect(store.getMeta("shared")?.scheduleId).toBe("sched-b");
  });
});

// Record `count` runs for a schedule with strictly increasing timestamps so the
// newest-first ordering is deterministic. Returns sessionIds oldest-first.
function seedRuns(store: SessionMetaStore, scheduleId: string, count: number): string[] {
  const sessionIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const sessionId = `${scheduleId}-s${i}`;
    const recordedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000).toISOString();
    store.recordScheduleRun(scheduleId, sessionId, recordedAt);
    sessionIds.push(sessionId);
  }
  return sessionIds;
}

describe("pruneScheduleRuns", () => {
  it("prunes only the oldest runs of this schedule and is a no-op once it is within the limit", () => {
    const ids = seedRuns(store, "sched-a", 6); // s0 (oldest) … s5 (newest)
    store.recordScheduleRun("other", "other-1");

    const deleted = store.pruneScheduleRuns("sched-a", 3);

    expect(deleted).toBe(3);
    expect(store.listSessionIdsBySchedule("sched-a")).toEqual([ids[5], ids[4], ids[3]]);
    expect(store.pruneScheduleRuns("sched-a", 3)).toBe(0);
    expect(store.pruneScheduleRuns("sched-a", 5)).toBe(0);
    expect(store.listScheduleRuns("sched-a")).toHaveLength(3);
    // Unrelated schedules are untouched.
    expect(store.listSessionIdsBySchedule("other")).toEqual(["other-1"]);
  });

  it("never prunes rows for retained session ids even when older than the cap", () => {
    const ids = seedRuns(store, "sched-a", 6); // s0 … s5

    // Keep newest 2 (s5, s4) but also protect an old session (s0).
    const deleted = store.pruneScheduleRuns("sched-a", 2, [ids[0]]);

    expect(deleted).toBe(3); // s1, s2, s3 removed; s0 protected, s4/s5 kept
    expect(store.listSessionIdsBySchedule("sched-a")).toEqual([ids[5], ids[4], ids[0]]);
  });

  it("guards against non-positive keep values without deleting everything", () => {
    seedRuns(store, "sched-a", 4);

    expect(store.pruneScheduleRuns("sched-a", 0)).toBe(0);
    expect(store.pruneScheduleRuns("sched-a", -5)).toBe(0);
    expect(store.pruneScheduleRuns("sched-a", 1.5)).toBe(0);
    expect(store.listScheduleRuns("sched-a")).toHaveLength(4);
  });
});

describe("resolveScheduleRunsKeep", () => {
  const ENV_KEY = "BRIDGE_SCHEDULE_RUNS_KEEP";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores an invalid BRIDGE_SCHEDULE_RUNS_KEEP and falls back to the default", () => {
    for (const bad of ["0", "-3", "abc", "12.5", " ", ""]) {
      vi.stubEnv(ENV_KEY, bad);
      expect(resolveScheduleRunsKeep(undefined)).toBe(DEFAULT_SCHEDULE_RUNS_KEEP);
    }
  });

  it("keeps autoArchiveKeep plus headroom when it exceeds the base", () => {
    vi.stubEnv(ENV_KEY, "100");
    // autoArchiveKeep below base → base wins.
    expect(resolveScheduleRunsKeep(20)).toBe(100);
    // autoArchiveKeep above base → autoArchiveKeep + headroom (50) wins.
    expect(resolveScheduleRunsKeep(200)).toBe(250);
  });

  it("ignores non-positive or non-integer autoArchiveKeep", () => {
    vi.stubEnv(ENV_KEY, "100");
    expect(resolveScheduleRunsKeep(0)).toBe(100);
    expect(resolveScheduleRunsKeep(-5)).toBe(100);
    expect(resolveScheduleRunsKeep(3.5)).toBe(100);
  });
});
