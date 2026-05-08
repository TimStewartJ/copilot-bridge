import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSessionMetaStore } from "../session-meta-store.js";
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

    expect((db.prepare("SELECT COUNT(*) AS count FROM session_meta").get() as any).count).toBe(0);
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
