import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus, makeAgentSessionStub } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import type { ImageBudgetHost } from "../image-budget.js";

function createManager(extraDeps: Record<string, unknown> = {}) {
  const db = setupTestDb();
  const manager = new SessionManager({
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: { findTaskBySessionId: vi.fn().mockReturnValue(null) } as any,
    settingsStore: { getMcpServers: () => ({}), getSettings: () => ({}) } as any,
    config: { sessionMcpServers: {} },
    ...extraDeps,
  }) as any;
  manager.backend = {};
  const session = makeAgentSessionStub({ disconnect: vi.fn() });
  manager.sessionObjects.set("s1", session);
  return { manager, session, host: manager.imageBudget.host as ImageBudgetHost };
}

describe("SessionManager image-budget host", () => {
  it("holds the chat so nothing else starts or steers, and lets the user's Stop cancel the continuation", async () => {
    const { manager, host } = createManager();
    expect(host.hold("s1")).toBe(true);
    expect(manager.isSessionBusy("s1")).toBe(true);
    expect(host.hold("s1")).toBe(false);
    manager.imageBudget.pauses.set("s1", { cancelled: false });
    await expect(manager.steerSession("s1", "hi")).rejects.toThrow("Bridge is summarizing the images in this chat");
    expect(() => manager.startWork("s1", "hi")).toThrow(/busy/);
    await expect(manager.abortSession("s1")).resolves.toBe(true);
    expect(manager.imageBudget.pauses.get("s1")).toEqual({ cancelled: true });
  });

  it("only stops turns Bridge may stop", () => {
    const { manager, host } = createManager();
    expect(host.runningTurn("s1")).toBe("none");
    manager.runStateController.hasSessionRun = () => true;
    manager.runStateController.getSessionRunAttentionMode = () => "normal";
    expect(host.runningTurn("s1")).toBe("stoppable");
    manager.runStateController.getSessionRunAttentionMode = () => "quiet";
    expect(host.runningTurn("s1")).toBe("keep");
    const helm = createManager({ resolveSessionProfile: () => ({ id: "helm" }) });
    helm.manager.runStateController.hasSessionRun = () => true;
    expect(helm.host.runningTurn("s1")).toBe("keep");
  });

  it("finishes in one step: drops the stopped turn's tail while held, releases, then continues as a system turn", () => {
    const { manager, session, host } = createManager();
    const steps: string[] = [];
    vi.spyOn(manager.sessionRunner, "discardHeldTurn").mockImplementation(() => steps.push(`discard busy=${manager.isSessionBusy("s1")}`));
    const startWork = vi.spyOn(manager.sessionRunner, "startWork").mockImplementation(() => { steps.push(`continue busy=${manager.isSessionBusy("s1")}`); });
    vi.spyOn(manager.sessionRunner, "getSessionAgentMode").mockReturnValue("autopilot");
    host.hold("s1");
    host.finish("s1", session, { stopped: true, continuation: { prompt: "go on" } });
    expect(steps).toEqual(["discard busy=true", "continue busy=false"]);
    expect(startWork).toHaveBeenCalledWith("s1", "go on", undefined, { promptSource: "system", mode: "autopilot" });
  });

  it("flags the chat instead of continuing when its handle was replaced or the stop never settled", () => {
    const { manager, host } = createManager();
    const markSessionAttention = vi.spyOn(manager, "markSessionAttention");
    const startWork = vi.spyOn(manager.sessionRunner, "startWork");
    host.hold("s1");
    host.finish("s1", makeAgentSessionStub({}), { stopped: true, continuation: { prompt: "go on" } });
    host.hold("s1");
    host.finish("s1", manager.sessionObjects.get("s1"), { stopped: true, attention: true });
    expect(startWork).not.toHaveBeenCalled();
    expect(markSessionAttention).toHaveBeenCalledTimes(2);
    expect(manager.isSessionBusy("s1")).toBe(false);
  });
});
