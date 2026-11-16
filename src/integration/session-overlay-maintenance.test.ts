import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ApiRouteTestState } from "../test-support/api-routes.js";
import { installApiRouteTestHooks } from "../test-support/api-routes.js";
import { createSessionOverlayMaintenance } from "../server/session-overlay-maintenance.js";
import { createTriggerResultDelivery } from "../server/triggers/messages.js";
import { createChatTrigger, endTrigger } from "../server/__tests__/helpers.js";

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

function ageRow(table: string, id: string, updatedAt = OLD_ISO): void {
  db.prepare(`UPDATE ${table} SET updatedAt = ? WHERE id = ?`).run(updatedAt, id);
}

describe("session overlay maintenance", () => {
  it("removes dangling task links, runs the reaper, deletes deleted-trigger runs, and prunes stopped rows", async () => {
    ctx.cliSessionCatalog = { listSessions: () => [], hasSession: async () => false } as any;
    ctx.bridgeSessionStateStore.setTitleOverride("orphan-overlay", "Orphan");
    ageState("orphan-overlay");

    const task = ctx.taskStore.createTask("Dangling");
    for (const sessionId of ["present-session", "gone-linked"]) ctx.taskStore.linkSession(task.id, sessionId);
    db.prepare("UPDATE task_sessions SET linkedAt = ?").run(OLD_ISO);
    mkdirSync(join(ctx.copilotHome!, "session-state", "present-session"), { recursive: true });
    ctx.bridgeSessionStateStore.setTitleOverride("gone-linked", "Gone");
    ageState("gone-linked");

    ctx.triggerStore!.recordRun({ triggerId: "deleted-trigger", sessionId: "run-1" }, OLD_ISO);

    const deferStore = ctx.deferredPromptStore!;
    const triggerStore = ctx.triggerStore!;
    const terminalPrompt = deferStore.create("gone-session", "done", OLD_ISO);
    deferStore.complete(terminalPrompt.id);
    ageRow("deferred_prompts", terminalPrompt.id);
    const recentTerminal = deferStore.create("present-session", "recent", OLD_ISO);
    deferStore.complete(recentTerminal.id);
    const terminalDelivery = deferStore.enqueueDelivery(createTriggerResultDelivery(
      { triggerId: "trigger-1", parentSessionId: "gone-session" },
      "Done.",
      { deliveryId: "terminal-delivery" },
    ), OLD_ISO);
    deferStore.complete(terminalDelivery.id);
    ageRow("deferred_prompts", terminalDelivery.id);
    const livePrompt = deferStore.create("live-session", "future", "2099-01-01T00:00:00.000Z");

    const terminalTrigger = createChatTrigger(triggerStore, "gone-session", { nextRunAt: OLD_ISO });
    endTrigger(db, terminalTrigger.id, "completed");
    ageRow("triggers", terminalTrigger.id);
    const liveTrigger = createChatTrigger(triggerStore, "live-session");

    const sessionsChanged: string[] = [];
    ctx.globalBus.subscribe((event: any) => {
      if (event.type === "sessions:changed") sessionsChanged.push(event.type);
    });

    const maintenance = createSessionOverlayMaintenance(ctx, { logger: { log: vi.fn(), error: vi.fn() } });
    const result = await maintenance.runOnce();
    maintenance.stop();

    expect(result.removedDanglingLinks).toBe(1);
    expect(ctx.taskStore.getTask(task.id)!.sessionIds).toEqual(["present-session"]);
    expect(result.reaped).toBe(2);
    expect(ctx.bridgeSessionStateStore.getState("gone-linked")).toBeUndefined();
    expect(result.deletedTriggerRuns).toBe(1);
    expect(result.prunedDeferredPrompts).toBe(2);
    expect(result.prunedTriggers).toBe(1);
    expect(sessionsChanged).toHaveLength(1);

    expect(ctx.bridgeSessionStateStore.getState("orphan-overlay")).toBeUndefined();
    expect(deferStore.get(terminalPrompt.id)).toBeUndefined();
    expect(deferStore.get(recentTerminal.id)).toBeDefined();
    expect(deferStore.get(terminalDelivery.id)).toBeUndefined();
    expect(deferStore.get(livePrompt.id)).toBeDefined();
    expect(triggerStore.get(terminalTrigger.id)).toBeUndefined();
    expect(triggerStore.get(liveTrigger.id)).toBeDefined();
  });

  it("arms an unref'd interval on start and disposes it on stop", async () => {
    ctx.cliSessionCatalog = { listSessions: () => [] } as any;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const maintenance = createSessionOverlayMaintenance(ctx, {
      intervalMs: 60_000,
      logger: { log: vi.fn(), error: vi.fn() },
    });
    await maintenance.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const timer = setIntervalSpy.mock.results[0]!.value as ReturnType<typeof setInterval>;
    expect((timer as any).hasRef?.()).toBe(false);

    maintenance.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);

    // Stopped maintenance never re-arms.
    await maintenance.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
