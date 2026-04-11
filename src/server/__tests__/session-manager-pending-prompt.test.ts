import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

describe("SessionManager pendingPrompt lifecycle", () => {
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

  it("stops advertising pendingPrompt after user.message arrives", async () => {
    const { manager, eventBusRegistry } = createManager();
    let handler: ((event: any) => void) | undefined;
    let releaseSend: (() => void) | undefined;

    const session = {
      on: vi.fn((cb: (event: any) => void) => {
        handler = cb;
        return vi.fn();
      }),
      send: vi.fn(async () => {
        handler?.({
          type: "user.message",
          data: { content: "hello there" },
          timestamp: "2026-04-11T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
      }),
    };

    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello there");

    for (let i = 0; i < 5; i++) await Promise.resolve();

    const bus = eventBusRegistry.getBus("session-1");
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(bus?.getSnapshot().pendingPrompt).toBeUndefined();

    releaseSend?.();
    await Promise.resolve();
    await Promise.resolve();
    handler?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-11T00:00:01.000Z",
    });
    await Promise.resolve();
  });
});
