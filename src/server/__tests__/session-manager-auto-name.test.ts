import { describe, expect, it, vi } from "vitest";
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";
import { openMemoryDatabase } from "../db.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createGlobalBus } from "../global-bus.js";
import { SessionManager } from "../session-manager.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";

function createHarness() {
  const db = openMemoryDatabase();
  const globalBus = createGlobalBus();
  const sessionMetaStore = createSessionMetaStore(db);
  const manager = new SessionManager({
    globalBus,
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    sessionMetaStore,
    taskStore: createTaskStore(db, globalBus),
    config: { sessionMcpServers: {} },
  }) as any;
  const maybeAutoNameSession = vi.fn();
  manager.sessionNameAutogenerator.maybeAutoNameSession = maybeAutoNameSession;
  return {
    manager,
    sessionMetaStore,
    bridgeSessionStateStore: createBridgeSessionStateStore(db),
    maybeAutoNameSession,
  };
}

describe("SessionManager fork auto-name requests", () => {
  it("uses only the first new fork message and consumes the persisted request", () => {
    const {
      manager,
      sessionMetaStore,
      bridgeSessionStateStore,
      maybeAutoNameSession,
    } = createHarness();
    const session = {};
    sessionMetaStore.setPendingAutoName("fork-session", "Fork of Original session");

    manager.maybeAutoNameSession("fork-session", {
      session,
      userMessages: ["Investigate the new failure mode"],
    });

    expect(maybeAutoNameSession).toHaveBeenCalledWith("fork-session", {
      session,
      userMessages: ["Investigate the new failure mode"],
      includeHistory: false,
      replaceExistingName: "Fork of Original session",
    });
    expect(bridgeSessionStateStore.getState("fork-session")).toBeUndefined();

    manager.maybeAutoNameSession("fork-session", {
      session,
      userMessages: ["Follow-up"],
    });
    expect(maybeAutoNameSession).toHaveBeenLastCalledWith("fork-session", {
      session,
      userMessages: ["Follow-up"],
    });
  });

  it("clears a pending request after an explicit rename succeeds", async () => {
    const {
      manager,
      sessionMetaStore,
      bridgeSessionStateStore,
    } = createHarness();
    sessionMetaStore.setPendingAutoName("fork-session", "Fork of Original session");
    manager.sessionNameRpc.setSessionName = vi.fn(async () => {});

    await manager.setSessionName("fork-session", "Manual fork title");

    expect(bridgeSessionStateStore.getState("fork-session")).toBeUndefined();
  });

  it("allows the persisted request to replace an inherited title when no provisional title was seeded", () => {
    const {
      manager,
      sessionMetaStore,
      maybeAutoNameSession,
    } = createHarness();
    sessionMetaStore.setPendingAutoName("fork-session");

    manager.maybeAutoNameSession("fork-session", {
      session: {},
      userMessages: ["Investigate the new failure mode"],
    });

    expect(maybeAutoNameSession).toHaveBeenCalledWith("fork-session", {
      session: {},
      userMessages: ["Investigate the new failure mode"],
      includeHistory: false,
      replaceExistingName: true,
    });
  });
});
