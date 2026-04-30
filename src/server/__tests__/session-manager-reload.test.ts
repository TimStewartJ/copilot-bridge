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
      setModel: vi.fn(),
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
    // Resume must NOT call setModel — existing sessions keep their persisted SDK model.
    expect(resumedSession.setModel).not.toHaveBeenCalled();
  });

  it("rejects busy sessions", async () => {
    const manager = createManager();
    manager.client = { resumeSession: vi.fn() };
    manager.sessionRuns.set("busy-session", {
      state: "busy",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    await expect(manager.reloadSession("busy-session")).rejects.toThrow("Cannot reload a busy session");
    expect(manager.client.resumeSession).not.toHaveBeenCalled();
  });

  it("rejects stalled sessions", async () => {
    const manager = createManager();
    manager.client = { resumeSession: vi.fn() };
    manager.sessionRuns.set("stalled-session", {
      state: "stalled",
      startedAt: Date.now() - 5_000,
      lastEventAt: Date.now() - 5_000,
      stalledAt: Date.now() - 1_000,
    });

    await expect(manager.reloadSession("stalled-session")).rejects.toThrow("Cannot reload a busy session");
    expect(manager.client.resumeSession).not.toHaveBeenCalled();
  });
});

describe("SessionManager warmSession", () => {
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
        getMcpServers: () => ({}),
        getSettings: () => ({ model: "claude-opus-4.7" }),
      } as any,
      config: { sessionMcpServers: {} },
    }) as any;
  }

  it("does not call setModel on the resumed session", async () => {
    const manager = createManager();
    const resumedSession = {
      setModel: vi.fn(),
      rpc: {
        mcp: { list: vi.fn().mockResolvedValue({ servers: [] }) },
      },
    };
    manager.client = { resumeSession: vi.fn().mockResolvedValue(resumedSession) };

    await manager.warmSession("session-warm-1");

    expect(resumedSession.setModel).not.toHaveBeenCalled();
    expect(manager.sessionObjects.get("session-warm-1")).toBe(resumedSession);
  });
});

describe("SessionManager getSessionMessages resume", () => {
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
        getMcpServers: () => ({}),
        getSettings: () => ({ model: "claude-opus-4.7" }),
      } as any,
      config: { sessionMcpServers: {} },
    }) as any;
  }

  it("does not call setModel when cold-resuming to load messages", async () => {
    const manager = createManager();
    const resumedSession = {
      setModel: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    manager.client = { resumeSession: vi.fn().mockResolvedValue(resumedSession) };

    await manager.getSessionMessages("session-msg-1");

    expect(resumedSession.setModel).not.toHaveBeenCalled();
    expect(resumedSession.getMessages).toHaveBeenCalledOnce();
  });

  it("treats cold message resume as busy until messages are loaded", async () => {
    const manager = createManager();
    const resumedSession = {
      setModel: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    let resolveResume!: (session: typeof resumedSession) => void;
    manager.client = {
      resumeSession: vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
        resolveResume = resolve;
      })),
    };

    const loading = manager.getSessionMessages("session-msg-race");

    expect(manager.isSessionBusy("session-msg-race")).toBe(true);
    expect(manager.getSessionRunState("session-msg-race")).toBe("busy");
    expect(manager.getActiveSessions()).toContain("session-msg-race");
    await expect(manager.setSessionModel("session-msg-race", "gpt-5.5"))
      .rejects.toThrow("Cannot switch model on a busy session");

    resolveResume(resumedSession);
    await loading;

    expect(manager.isSessionBusy("session-msg-race")).toBe(false);
    expect(manager.getActiveSessions()).not.toContain("session-msg-race");
  });

  it("keeps overlapping cold message resumes busy until the last resume finishes", async () => {
    const manager = createManager();
    const firstSession = {
      disconnect: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    const secondSession = {
      disconnect: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    type ResumedSession = typeof firstSession;
    const resumeResolvers: Array<(session: ResumedSession) => void> = [];
    manager.client = {
      resumeSession: vi.fn(() => new Promise<ResumedSession>((resolve) => {
        resumeResolvers.push(resolve);
      })),
    };

    const firstLoad = manager.getSessionMessages("session-msg-overlap");
    const secondLoad = manager.getSessionMessages("session-msg-overlap");

    expect(resumeResolvers).toHaveLength(2);
    expect(manager.getActiveSessions()).toContain("session-msg-overlap");

    resumeResolvers[0](firstSession);
    await firstLoad;

    expect(manager.isSessionBusy("session-msg-overlap")).toBe(true);
    expect(manager.getActiveSessions()).toContain("session-msg-overlap");

    manager.evictAllCachedSessions();

    expect(firstSession.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.get("session-msg-overlap")).toBe(firstSession);

    resumeResolvers[1](secondSession);
    await secondLoad;

    expect(secondSession.disconnect).toHaveBeenCalledTimes(1);
    expect(firstSession.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("session-msg-overlap")).toBe(false);
    expect(manager.isSessionBusy("session-msg-overlap")).toBe(false);
  });

  it("does not let a superseded cold message resume overwrite a newer cached session", async () => {
    const manager = createManager();
    const resumedSession = {
      disconnect: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([{ type: "assistant.message", data: { content: "stale" } }]),
    };
    let resolveResume!: (session: typeof resumedSession) => void;
    const newerSession = {
      getMessages: vi.fn().mockResolvedValue([]),
    };
    manager.client = {
      resumeSession: vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
        resolveResume = resolve;
      })),
    };

    const loading = manager.getSessionMessages("session-msg-superseded");
    manager.sessionObjects.set("session-msg-superseded", newerSession);

    resolveResume(resumedSession);
    await loading;

    expect(manager.sessionObjects.get("session-msg-superseded")).toBe(newerSession);
    expect(resumedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(resumedSession.getMessages).not.toHaveBeenCalled();
    expect(newerSession.getMessages).toHaveBeenCalledOnce();
  });

  it("does not call setModel when re-resuming after stale cache failure", async () => {
    const manager = createManager();
    const staleSession = {
      setModel: vi.fn(),
      getMessages: vi.fn().mockRejectedValue(new Error("RPC disconnected")),
    };
    const freshSession = {
      setModel: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    manager.sessionObjects.set("session-msg-2", staleSession);
    manager.client = { resumeSession: vi.fn().mockResolvedValue(freshSession) };

    await manager.getSessionMessages("session-msg-2");

    expect(staleSession.setModel).not.toHaveBeenCalled();
    expect(freshSession.setModel).not.toHaveBeenCalled();
    expect(freshSession.getMessages).toHaveBeenCalledOnce();
  });
});
