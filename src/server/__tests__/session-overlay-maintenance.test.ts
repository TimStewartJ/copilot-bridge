import { describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import { installApiRouteTestHooks } from "./api-routes-test-helpers.js";
import { createSessionOverlayMaintenance } from "../session-overlay-maintenance.js";

let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ ctx, db } = state);
});

const OLD_ISO = "2020-01-01T00:00:00.000Z";

function ageState(sessionId: string, updatedAt = OLD_ISO): void {
  db.prepare("UPDATE bridge_session_state SET createdAt = ?, updatedAt = ? WHERE sessionId = ?")
    .run(updatedAt, updatedAt, sessionId);
}

function ageDefer(table: string, id: string, updatedAt = OLD_ISO): void {
  db.prepare(`UPDATE ${table} SET updatedAt = ? WHERE id = ?`).run(updatedAt, id);
}

describe("session overlay maintenance", () => {
  it("runs the reaper, deletes deleted-schedule runs, and prunes terminal defers", () => {
    ctx.cliSessionCatalog = { listSessions: () => [] } as any;
    ctx.bridgeSessionStateStore.setTitleOverride("orphan-overlay", "Orphan");
    ageState("orphan-overlay");

    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run("deleted-schedule", "run-1", OLD_ISO);

    const deferStore = ctx.deferredPromptStore!;
    const loopStore = ctx.deferLoopStore!;
    const outboxStore = ctx.sessionMessageOutboxStore!;
    const terminalPrompt = deferStore.create("gone-session", "done", OLD_ISO);
    deferStore.markCompletedById(terminalPrompt.id);
    ageDefer("deferred_prompts", terminalPrompt.id);
    const livePrompt = deferStore.create("live-session", "future", "2099-01-01T00:00:00.000Z");

    const terminalLoop = loopStore.create({
      sessionId: "gone-session",
      prompt: "done loop",
      intervalSeconds: 600,
      nextRunAt: OLD_ISO,
    });
    loopStore.markCompleted(terminalLoop.id);
    ageDefer("defer_loops", terminalLoop.id);
    const liveLoop = loopStore.create({
      sessionId: "live-session",
      prompt: "live loop",
      intervalSeconds: 600,
      nextRunAt: "2099-01-01T00:00:00.000Z",
    });
    const terminalMessage = outboxStore.enqueue({
      id: "terminal-message",
      sessionId: "gone-session",
      prompt: "Done",
      source: "defer_result",
    })!;
    outboxStore.markCompletedById(terminalMessage.id);
    ageDefer("session_message_outbox", terminalMessage.id);

    const sessionsChanged: string[] = [];
    ctx.globalBus.subscribe((event: any) => {
      if (event.type === "sessions:changed") sessionsChanged.push(event.type);
    });

    const maintenance = createSessionOverlayMaintenance(ctx, { logger: { log: vi.fn(), error: vi.fn() } });
    const result = maintenance.runOnce();
    maintenance.stop();

    expect(result.reaped).toBe(1);
    expect(result.deletedScheduleRuns).toBe(1);
    expect(result.prunedDeferredPrompts).toBe(1);
    expect(result.prunedDeferLoops).toBe(1);
    expect(result.prunedSessionMessages).toBe(1);
    expect(sessionsChanged).toHaveLength(1);

    expect(ctx.bridgeSessionStateStore.getState("orphan-overlay")).toBeUndefined();
    expect(deferStore.get(terminalPrompt.id)).toBeUndefined();
    expect(deferStore.get(livePrompt.id)).toBeDefined();
    expect(loopStore.get(terminalLoop.id)).toBeUndefined();
    expect(loopStore.get(liveLoop.id)).toBeDefined();
    expect(outboxStore.get(terminalMessage.id)).toBeUndefined();
  });

  it("keeps recently-terminal defers until the retention window elapses", () => {
    ctx.cliSessionCatalog = { listSessions: () => [] } as any;
    const deferStore = ctx.deferredPromptStore!;
    const recentTerminal = deferStore.create("some-session", "done", OLD_ISO);
    deferStore.markCompletedById(recentTerminal.id);

    const maintenance = createSessionOverlayMaintenance(ctx, { logger: { log: vi.fn(), error: vi.fn() } });
    const result = maintenance.runOnce();
    maintenance.stop();

    expect(result.prunedDeferredPrompts).toBe(0);
    expect(result.prunedSessionMessages).toBe(0);
    expect(deferStore.get(recentTerminal.id)).toBeDefined();
  });

  it("arms an unref'd interval on start and disposes it on stop", () => {
    ctx.cliSessionCatalog = { listSessions: () => [] } as any;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const maintenance = createSessionOverlayMaintenance(ctx, {
      intervalMs: 60_000,
      logger: { log: vi.fn(), error: vi.fn() },
    });
    maintenance.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const timer = setIntervalSpy.mock.results[0]!.value as ReturnType<typeof setInterval>;
    expect((timer as any).hasRef?.()).toBe(false);

    maintenance.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);

    // Stopped maintenance never re-arms.
    maintenance.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
