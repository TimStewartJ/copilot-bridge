import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

describe("SessionManager Fleet", () => {
  function createManager() {
    const db = setupTestDb();
    const eventBusRegistry = createEventBusRegistry();
    const manager = new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry,
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: {
        getMcpServers: () => ({}),
        getSettings: () => ({ mcpServers: {} }),
      } as any,
      config: { sessionMcpServers: {} },
    }) as any;

    return { manager, eventBusRegistry };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts Fleet without advertising a pending prompt", async () => {
    const { manager, eventBusRegistry } = createManager();
    vi.spyOn(manager, "hasPlan").mockReturnValue(true);

    let handler: ((event: any) => void) | undefined;
    const fleetStart = vi.fn().mockResolvedValue({ started: true });
    const session = {
      on: vi.fn((cb: (event: any) => void) => {
        handler = cb;
        return vi.fn();
      }),
      rpc: {
        fleet: {
          start: fleetStart,
        },
      },
    };

    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startFleet("session-1", "Ship it");

    const bus = eventBusRegistry.getBus("session-1");
    await vi.waitFor(() => {
      expect(fleetStart).toHaveBeenCalledWith({ prompt: "Ship it" });
    });
    expect(bus?.getSnapshot().pendingPrompt).toBeUndefined();

    handler?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-17T00:00:01.000Z",
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("rejects Fleet launches when the session has no plan", () => {
    const { manager } = createManager();
    vi.spyOn(manager, "hasPlan").mockReturnValue(false);
    manager.client = {};

    expect(() => manager.startFleet("session-1")).toThrow("Session has no plan to run with Fleet");
  });
});
