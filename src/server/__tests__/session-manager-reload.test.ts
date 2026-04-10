import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";

describe("SessionManager reloadSession", () => {
  function createManager() {
    const db = setupTestDb();
    return new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: {
        getMcpServers: () => ({ demo: { command: "echo", args: ["hi"] } }),
        getSettings: () => ({ mcpServers: { demo: { command: "echo", args: ["hi"] } } }),
      } as any,
      config: { sessionMcpServers: {} },
    }) as any;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts only the requested cached session and resumes it with fresh config", async () => {
    const manager = createManager();
    const oldSession = { disconnect: vi.fn() };
    const otherSession = { disconnect: vi.fn() };
    const resumedSession = {
      rpc: {
        mcp: {
          list: vi.fn().mockResolvedValue({
            servers: [{ name: "demo", status: "connected", source: "settings" }],
          }),
        },
      },
    };
    const resumeSession = vi.fn().mockResolvedValue(resumedSession);

    manager.client = { resumeSession };
    manager.sessionObjects.set("session-1", oldSession);
    manager.sessionObjects.set("session-2", otherSession);
    manager.mcpStatus.set("session-1", [{ name: "stale", status: "failed" }]);

    const servers = await manager.reloadSession("session-1");

    expect(oldSession.disconnect).toHaveBeenCalledTimes(1);
    expect(otherSession.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.get("session-1")).toBe(resumedSession);
    expect(manager.sessionObjects.get("session-2")).toBe(otherSession);
    expect(resumeSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        mcpServers: { demo: { command: "echo", args: ["hi"] } },
      }),
    );
    expect(servers).toEqual([{ name: "demo", status: "connected", source: "settings" }]);
  });

  it("rejects busy sessions", async () => {
    const manager = createManager();
    manager.client = { resumeSession: vi.fn() };
    manager.activeSessions.add("busy-session");

    await expect(manager.reloadSession("busy-session")).rejects.toThrow("Cannot reload a busy session");
    expect(manager.client.resumeSession).not.toHaveBeenCalled();
  });
});
