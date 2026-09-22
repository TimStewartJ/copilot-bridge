import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { initializeSchedulerAndDeferredRunners } from "../app-context-factory.js";

describe("startup runners", () => {
  it("initializes the scheduler with its stores before starting deferred runners", () => {
    const order: string[] = [];
    const initialize = vi.fn(() => { order.push("scheduler"); });
    const ctx = {
      scheduler: { initialize },
      sessionManager: { id: "manager" },
      scheduleStore: { id: "schedules" },
      taskStore: { id: "tasks" },
      sessionMetaStore: { id: "meta" },
      globalBus: { id: "bus" },
      deferredPromptStore: { id: "deferred" },
      deferLoopStore: { id: "loops" },
      deferredPromptRunner: { start: vi.fn(() => { order.push("deferred"); }) },
      deferLoopRunner: { start: vi.fn(() => { order.push("loops"); }) },
    } as unknown as AppContext;

    initializeSchedulerAndDeferredRunners(ctx);

    expect(initialize).toHaveBeenCalledExactlyOnceWith(ctx.sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
      deferredPromptStore: ctx.deferredPromptStore,
      deferLoopStore: ctx.deferLoopStore,
    });
    expect(order).toEqual(["scheduler", "deferred", "loops"]);
  });
});
