import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createGlobalBus, type StatusEvent } from "../global-bus.js";
import { createScheduleStore, type ScheduleStore } from "../schedule-store.js";
import { enforceScheduleSessionRetention } from "../schedule-session-retention.js";
import { createSessionMetaStore, type SessionMetaStore } from "../session-meta-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let scheduleStore: ScheduleStore;
let sessionMetaStore: SessionMetaStore;

beforeEach(() => {
  db = setupTestDb();
  scheduleStore = createScheduleStore(db);
  sessionMetaStore = createSessionMetaStore(db);
});

afterEach(() => {
  db.close();
});

describe("schedule session retention", () => {
  const baseSchedule = {
    taskId: "task-1",
    name: "Daily",
    prompt: "Run",
    type: "cron" as const,
    cron: "0 8 * * *",
  };

  it("does nothing when autoArchiveKeep is not configured", async () => {
    const schedule = scheduleStore.createSchedule(baseSchedule);
    sessionMetaStore.recordScheduleRun(schedule.id, "newer", "2026-01-02T00:00:00.000Z");
    sessionMetaStore.recordScheduleRun(schedule.id, "older", "2026-01-01T00:00:00.000Z");
    const bus = createGlobalBus();

    const result = await enforceScheduleSessionRetention({
      schedule,
      sessionMetaStore,
      sessionManager: {
        listSessionsFromDisk: async () => [
          { sessionId: "newer" },
          { sessionId: "older" },
        ],
        isSessionBusy: () => false,
      } as any,
      globalBus: bus,
    });

    expect(result).toEqual({ archivedSessionIds: [], skippedSessionIds: [], retainableSessionIds: [] });
    expect(sessionMetaStore.isArchived("older")).toBe(false);
  });

  it("archives old eligible sessions and skips missing, busy, and deferred sessions", async () => {
    const schedule = scheduleStore.createSchedule({ ...baseSchedule, autoArchiveKeep: 1 });
    sessionMetaStore.recordScheduleRun(schedule.id, "latest", "2026-01-05T00:00:00.000Z");
    sessionMetaStore.recordScheduleRun(schedule.id, "busy", "2026-01-04T00:00:00.000Z");
    sessionMetaStore.recordScheduleRun(schedule.id, "deferred", "2026-01-03T00:00:00.000Z");
    sessionMetaStore.recordScheduleRun(schedule.id, "missing", "2026-01-02T00:00:00.000Z");
    sessionMetaStore.recordScheduleRun(schedule.id, "old", "2026-01-01T00:00:00.000Z");
    const deferredPromptStore = createDeferredPromptStore(db);
    const deferLoopStore = createDeferLoopStore(db);
    deferredPromptStore.create("deferred", "Later", "2026-01-06T00:00:00.000Z");
    const bus = createGlobalBus();
    const events: StatusEvent[] = [];
    bus.subscribe((event) => events.push(event));

    const result = await enforceScheduleSessionRetention({
      schedule,
      sessionMetaStore,
      sessionManager: {
        listSessionsFromDisk: async () => [
          { sessionId: "latest" },
          { sessionId: "busy" },
          { sessionId: "deferred" },
          { sessionId: "old" },
        ],
        isSessionBusy: (sessionId: string) => sessionId === "busy",
      } as any,
      globalBus: bus,
      deferredPromptStore,
      deferLoopStore,
    });

    expect(result.archivedSessionIds).toEqual(["old"]);
    expect(result.skippedSessionIds).toEqual(["busy", "deferred", "missing"]);
    expect(result.retainableSessionIds).toEqual(["busy", "deferred"]);
    expect(sessionMetaStore.isArchived("latest")).toBe(false);
    expect(sessionMetaStore.isArchived("busy")).toBe(false);
    expect(sessionMetaStore.isArchived("deferred")).toBe(false);
    expect(sessionMetaStore.isArchived("missing")).toBe(false);
    expect(sessionMetaStore.isArchived("old")).toBe(true);
    expect(events).toEqual([
      { type: "session:archived", sessionId: "old", archived: true },
    ]);
  });

  it("skips archival when defer stores are unavailable", async () => {
    const schedule = scheduleStore.createSchedule({ ...baseSchedule, autoArchiveKeep: 1 });
    sessionMetaStore.recordScheduleRun(schedule.id, "newer", "2026-01-02T00:00:00.000Z");
    sessionMetaStore.recordScheduleRun(schedule.id, "older", "2026-01-01T00:00:00.000Z");

    const result = await enforceScheduleSessionRetention({
      schedule,
      sessionMetaStore,
      sessionManager: {
        listSessionsFromDisk: async () => [
          { sessionId: "newer" },
          { sessionId: "older" },
        ],
        isSessionBusy: () => false,
      } as any,
      globalBus: createGlobalBus(),
    });

    expect(result).toEqual({ archivedSessionIds: [], skippedSessionIds: ["older"], retainableSessionIds: ["older"] });
    expect(sessionMetaStore.isArchived("older")).toBe(false);
  });
});
