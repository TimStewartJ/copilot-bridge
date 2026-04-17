import { describe, expect, it, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

const { shutdownBridgeBrowserMock } = vi.hoisted(() => ({
  shutdownBridgeBrowserMock: vi.fn(),
}));

vi.mock("../agent-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-browser.js")>("../agent-browser.js");
  return {
    ...actual,
    shutdownBridgeBrowser: shutdownBridgeBrowserMock,
  };
});

describe("SessionManager graceful shutdown", () => {
  beforeEach(() => {
    shutdownBridgeBrowserMock.mockReset();
    shutdownBridgeBrowserMock.mockResolvedValue(undefined);
  });

  function createManager(overrides: Record<string, unknown> = {}) {
    const db = setupTestDb();
    return new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {} as any,
      config: { sessionMcpServers: {} },
      ...overrides,
    });
  }

  it("closes browser sessions and the primary bridge browser during graceful shutdown", async () => {
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const copilotHome = "/tmp/bridge-shutdown-home";
    const manager = createManager({
      browserSessionStore: { closeAll },
      copilotHome,
    }) as any;
    manager.client = { stop };

    await manager.gracefulShutdown();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(shutdownBridgeBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileDir: join(copilotHome, "browser-profile"),
      }),
      undefined,
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.client).toBeNull();
  });

  it("continues shutdown when primary bridge browser cleanup fails", async () => {
    shutdownBridgeBrowserMock.mockRejectedValue(new Error("close failed"));

    const closeAll = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = createManager({
      browserSessionStore: { closeAll },
    }) as any;
    manager.client = { stop };

    await manager.gracefulShutdown();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(shutdownBridgeBrowserMock).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.client).toBeNull();
  });
});
