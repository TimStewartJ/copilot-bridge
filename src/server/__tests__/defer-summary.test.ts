import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { mergeDeferSummaries } from "../defer-summary.js";
import type { DeferredPromptStore } from "../deferred-prompt-store.js";
import type { DeferLoopStore } from "../defer-loop-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let deferredPromptStore: DeferredPromptStore;
let deferLoopStore: DeferLoopStore;

beforeEach(() => {
  db = setupTestDb();
  deferredPromptStore = createDeferredPromptStore(db);
  deferLoopStore = createDeferLoopStore(db);
});

describe("defer summary", () => {
  it("combines one-shot and interval summaries with the earliest next run time", () => {
    deferredPromptStore.create("session-1", "One shot later", "2030-01-01T00:10:00.000Z");
    deferredPromptStore.create("session-1", "One shot latest", "2030-01-01T00:20:00.000Z");
    deferLoopStore.create({
      sessionId: "session-1",
      name: "interval",
      prompt: "Interval earlier",
      intervalSeconds: 60,
      nextRunAt: "2030-01-01T00:05:00.000Z",
    });
    deferLoopStore.create({
      sessionId: "session-2",
      name: "other",
      prompt: "Other",
      intervalSeconds: 60,
      nextRunAt: "2030-01-01T00:01:00.000Z",
    });

    const summary = mergeDeferSummaries(
      deferredPromptStore.getSummaryForSession("session-1"),
      deferLoopStore.getSummaryForSession("session-1"),
    );

    expect(summary).toEqual({
      count: 3,
      nextRunAt: "2030-01-01T00:05:00.000Z",
    });
  });
});
