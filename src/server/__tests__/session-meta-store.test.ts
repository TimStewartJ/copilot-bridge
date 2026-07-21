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
  it("getMeta returns undefined for unknown session", () => {
    expect(store.getMeta("unknown")).toBeUndefined();
  });

  it("setArchived creates meta entry", () => {
    store.setArchived("session-1", true);
    expect(store.isArchived("session-1")).toBe(true);
  });

  it("setArchived(false) removes entry", () => {
    store.setArchived("session-1", true);
    store.setArchived("session-1", false);
    expect(store.isArchived("session-1")).toBe(false);
    expect(store.getMeta("session-1")).toBeUndefined();
  });

  it("setArchived(false) preserves unrelated overlay fields", () => {
    const bridgeSessionState = createBridgeSessionStateStore(db);
    bridgeSessionState.setTitleOverride("session-1", "Manual title");

    store.setArchived("session-1", true);
    store.setArchived("session-1", false);

    expect(store.getMeta("session-1")).toBeUndefined();
    expect(bridgeSessionState.getState("session-1")?.titleOverride).toBe("Manual title");
  });

  it("isArchived returns false for unknown session", () => {
    expect(store.isArchived("nope")).toBe(false);
  });

  it("deleteMeta removes entry", () => {
    store.setArchived("session-1", true);
    store.deleteMeta("session-1");
    expect(store.getMeta("session-1")).toBeUndefined();
  });

  it("setScheduleMeta sets trigger info", () => {
    store.setScheduleMeta("session-1", "sched-1", "My Schedule");
    const meta = store.getMeta("session-1");
    expect(meta).toBeDefined();
    expect(meta!.triggeredBy).toBe("schedule");
    expect(meta!.scheduleId).toBe("sched-1");
    expect(meta!.scheduleName).toBe("My Schedule");
  });

  it("writes runtime metadata only to bridge_session_state", () => {
    store.setArchived("session-1", true);
    store.setScheduleMeta("session-1", "sched-1", "My Schedule");

    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'").get() as any)).toBeUndefined();
    expect(db.prepare(`
      SELECT archived, scheduleId, scheduleName
      FROM bridge_session_state
      WHERE sessionId = ?
    `).get("session-1")).toMatchObject({
      archived: 1,
      scheduleId: "sched-1",
      scheduleName: "My Schedule",
    });
  });

  it("setScheduleMeta preserves existing archive state", () => {
    store.setArchived("session-1", true);
    store.setScheduleMeta("session-1", "sched-1", "Test");
    const meta = store.getMeta("session-1");
    expect(meta!.archived).toBe(true);
    expect(meta!.triggeredBy).toBe("schedule");
  });

  it("listMeta returns all entries", () => {
    store.setArchived("s1", true);
    store.setArchived("s2", true);
    const all = store.listMeta();
    expect(Object.keys(all)).toHaveLength(2);
  });

  it("omits title-only and workspace-only overlay rows from meta reads", () => {
    const bridgeSessionState = createBridgeSessionStateStore(db);
    bridgeSessionState.setTitleOverride("title-only", "Manual title");
    bridgeSessionState.setPinnedCwd("workspace-only", "D:\\repo");

    expect(store.getMeta("title-only")).toBeUndefined();
    expect(store.getMeta("workspace-only")).toBeUndefined();
    expect(store.listMeta()).toEqual({});
  });

  it("includes attention-only rows in meta reads", () => {
    store.setLastAttentionAt("session-1", "2026-05-07T10:00:00.000Z");

    expect(store.getMeta("session-1")).toMatchObject({
      archived: false,
      lastAttentionAt: "2026-05-07T10:00:00.000Z",
    });
    expect(store.listMeta()["session-1"]?.lastAttentionAt).toBe("2026-05-07T10:00:00.000Z");
  });

  it("persists and clears bridge-synthesized terminal overlays", () => {
    store.setTerminalOverlay("session-1", {
      type: "aborted",
      runId: "run-1",
      turnId: "turn-1",
      content: "Partial answer",
      timestamp: "2026-07-21T17:00:00.000Z",
    });

    expect(store.getTerminalOverlay("session-1")).toEqual({
      type: "aborted",
      runId: "run-1",
      turnId: "turn-1",
      content: "Partial answer",
      timestamp: "2026-07-21T17:00:00.000Z",
    });
    expect(store.getMeta("session-1")?.terminalOverlay?.type).toBe("aborted");

    store.clearTerminalOverlay("session-1");
    expect(store.getTerminalOverlay("session-1")).toBeUndefined();
    expect(store.getMeta("session-1")).toBeUndefined();
  });

  it("listSessionIdsBySchedule returns sessions for a schedule", () => {
    store.recordScheduleRun("sched-a", "s1", "2026-01-01T00:00:00.000Z");
    store.recordScheduleRun("sched-a", "s2", "2026-01-02T00:00:00.000Z");
    store.recordScheduleRun("sched-b", "s3");

    const result = store.listSessionIdsBySchedule("sched-a");
    expect(result).toHaveLength(2);
    expect(result).toContain("s1");
    expect(result).toContain("s2");
    expect(store.listScheduleRuns("sched-a")).toMatchObject([
      { sessionId: "s2", recordedAt: "2026-01-02T00:00:00.000Z" },
      { sessionId: "s1", recordedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("listSessionIdsBySchedule returns empty for unknown schedule", () => {
    expect(store.listSessionIdsBySchedule("unknown")).toEqual([]);
  });

  it("listSessionIdsBySchedule preserves repeated runs of the same session", () => {
    store.recordScheduleRun("sched-a", "shared");
    store.recordScheduleRun("sched-a", "shared");

    expect(store.listSessionIdsBySchedule("sched-a")).toEqual(["shared", "shared"]);
  });

  it("listScheduleRuns normalizes and sorts mixed timestamp formats", () => {
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run("sched-a", "older", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run("sched-a", "newer", "2026-01-01 23:00:00");

    expect(store.listScheduleRuns("sched-a")).toMatchObject([
      { sessionId: "newer", recordedAt: "2026-01-01T23:00:00.000Z" },
      { sessionId: "older", recordedAt: "2026-01-01T00:00:00.000Z" },
    ]);
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
  it("keeps the newest N rows, prunes older ones, and preserves ordering", () => {
    const ids = seedRuns(store, "sched-a", 6); // s0 (oldest) … s5 (newest)
    store.recordScheduleRun("other", "other-1");

    const deleted = store.pruneScheduleRuns("sched-a", 3);

    expect(deleted).toBe(3);
    expect(store.listSessionIdsBySchedule("sched-a")).toEqual([ids[5], ids[4], ids[3]]);
    // Unrelated schedules are untouched.
    expect(store.listSessionIdsBySchedule("other")).toEqual(["other-1"]);
  });

  it("is idempotent and a no-op at or below the cap", () => {
    seedRuns(store, "sched-a", 3);

    expect(store.pruneScheduleRuns("sched-a", 5)).toBe(0);
    expect(store.pruneScheduleRuns("sched-a", 3)).toBe(0);
    expect(store.listScheduleRuns("sched-a")).toHaveLength(3);

    // First prune trims, second prune is a no-op.
    seedRuns(store, "sched-b", 5);
    expect(store.pruneScheduleRuns("sched-b", 2)).toBe(3);
    expect(store.pruneScheduleRuns("sched-b", 2)).toBe(0);
    expect(store.listScheduleRuns("sched-b")).toHaveLength(2);
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

  it("bounds growth when recording more runs than the resolved cap", () => {
    const cap = resolveScheduleRunsKeep(undefined); // default 500
    const ids = seedRuns(store, "sched-a", cap + 25);

    store.pruneScheduleRuns("sched-a", cap);

    const remaining = store.listSessionIdsBySchedule("sched-a");
    expect(remaining).toHaveLength(cap);
    // Newest `cap` sessions remain, newest-first; the 25 oldest were pruned.
    expect(remaining[0]).toBe(ids[ids.length - 1]);
    expect(remaining[remaining.length - 1]).toBe(ids[25]);
    expect(remaining).not.toContain(ids[24]);
  });
});

describe("resolveScheduleRunsKeep", () => {
  const ENV_KEY = "BRIDGE_SCHEDULE_RUNS_KEEP";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to DEFAULT_SCHEDULE_RUNS_KEEP", () => {
    vi.stubEnv(ENV_KEY, undefined);
    expect(resolveScheduleRunsKeep(undefined)).toBe(DEFAULT_SCHEDULE_RUNS_KEEP);
    expect(resolveScheduleRunsKeep(null)).toBe(DEFAULT_SCHEDULE_RUNS_KEEP);
  });

  it("honors a valid BRIDGE_SCHEDULE_RUNS_KEEP override", () => {
    vi.stubEnv(ENV_KEY, "10");
    expect(resolveScheduleRunsKeep(undefined)).toBe(10);
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
