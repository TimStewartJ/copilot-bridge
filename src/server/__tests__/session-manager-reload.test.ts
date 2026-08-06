import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus, makeAgentSessionStub } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";

function spyOnResumeCleanup(manager: any) {
  return {
    endSessionResume: vi.spyOn(manager, "endSessionResume"),
    flushPendingSessionEviction: vi.spyOn(manager, "flushPendingSessionEviction"),
  };
}

describe("SessionManager reloadSession", () => {
  function createManager() {
    const db = setupTestDb();
    return new SessionManager({
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
      clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
    }) as any;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts only the requested cached session and resumes it with fresh config", async () => {
    const manager = createManager();
    const oldSession = makeAgentSessionStub({ disconnect: vi.fn() });
    const otherSession = makeAgentSessionStub({ disconnect: vi.fn() });
    const resumedSession = {
      setModel: vi.fn(),
      listMcpServers: vi.fn().mockImplementation(async () => {
        expect(manager.isSessionBusy("session-1")).toBe(true);
        return {
          servers: [{ name: "demo", status: "connected", source: "settings" }],
        };
      }),
    };
    const resumeSession = vi.fn().mockResolvedValue(resumedSession);
    const cleanup = spyOnResumeCleanup(manager);

    manager.backend = { resumeSession };
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
    expect(resumedSession.listMcpServers).toHaveBeenCalledTimes(1);
    expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
    expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    // Resume must NOT call setModel — existing sessions keep their persisted SDK model.
    expect(resumedSession.setModel).not.toHaveBeenCalled();
  });

  it("releases the resume lifecycle exactly once when reload times out", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    let resolveResume!: (session: { disconnect: ReturnType<typeof vi.fn> }) => void;
    const resumeSession = vi.fn(() => new Promise<{ disconnect: ReturnType<typeof vi.fn> }>((resolve) => {
      resolveResume = resolve;
    }));
    const cleanup = spyOnResumeCleanup(manager);
    manager.backend = { resumeSession };

    try {
      const reloading = manager.reloadSession("session-timeout");
      const rejection = expect(reloading).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;

      expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
      expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
      expect(manager.isSessionBusy("session-timeout")).toBe(false);

      const lateSession = makeAgentSessionStub({ disconnect: vi.fn() });
      resolveResume(lateSession);
      await vi.advanceTimersByTimeAsync(0);
      expect(lateSession.disconnect).toHaveBeenCalledTimes(1);
      expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
      expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects busy or stalled sessions", async () => {
    for (const { label, runState } of [
      { label: "busy", runState: { state: "busy" as const, startedAt: Date.now(), lastEventAt: Date.now() } },
      { label: "stalled", runState: { state: "stalled" as const, startedAt: Date.now() - 5_000, lastEventAt: Date.now() - 5_000, stalledAt: Date.now() - 1_000 } },
    ]) {
      const manager = createManager();
      manager.backend = { resumeSession: vi.fn() };
      manager.sessionRuns.set(`${label}-session`, runState);

      await expect(manager.reloadSession(`${label}-session`)).rejects.toThrow("Cannot reload a busy session");
      expect(manager.backend.resumeSession, label).not.toHaveBeenCalled();
    }
  });

  it("starts MCP OAuth on an already cached session", async () => {
    const manager = createManager();
    const login = vi.fn().mockImplementation(async () => {
      expect(manager.isSessionBusy("session-auth")).toBe(true);
      return { authorizationUrl: "https://login.example.test" };
    });
    const list = vi.fn().mockResolvedValue({
      servers: [{ name: "demo", status: "needs-auth", source: "settings" }],
    });
    manager.backend = { resumeSession: vi.fn() };
    manager.sessionObjects.set("session-auth", {
      startMcpOauthLogin: login, listMcpServers: list,
    });
    const cleanup = spyOnResumeCleanup(manager);

    const result = await manager.loginMcpServer("session-auth", "DEMO", { forceReauth: true });

    expect(manager.backend.resumeSession).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      serverName: "demo",
      forceReauth: true,
      clientName: "Copilot Bridge",
    }));
    expect(result).toEqual({
      serverName: "demo",
      authorizationUrl: "https://login.example.test",
      servers: [{ name: "demo", status: "needs-auth", source: "settings" }],
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
    expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    expect(manager.isSessionBusy("session-auth")).toBe(false);
  });

  it("resumes a cold session before starting MCP OAuth", async () => {
    const manager = createManager();
    const login = vi.fn().mockResolvedValue({});
    const list = vi.fn().mockResolvedValue({
      servers: [{ name: "demo", status: "pending", source: "settings" }],
    });
    const resumedSession = {
      startMcpOauthLogin: login, listMcpServers: list,
    };
    const resumeSession = vi.fn().mockResolvedValue(resumedSession);
    const cleanup = spyOnResumeCleanup(manager);
    manager.backend = { resumeSession };

    const result = await manager.loginMcpServer("session-auth-cold", "demo");

    expect(resumeSession).toHaveBeenCalledWith(
      "session-auth-cold",
      expect.objectContaining({
        mcpServers: { demo: { command: "echo", args: ["hi"] } },
      }),
    );
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ serverName: "demo" }));
    expect(result).toEqual({
      serverName: "demo",
      servers: [{ name: "demo", status: "pending", source: "settings" }],
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
    expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
  });

  it("releases MCP login resume cleanup exactly once on timeout or resume failure", async () => {
    // timeout case
    {
      vi.useFakeTimers();
      const manager = createManager();
      manager.backend = {
        resumeSession: vi.fn(() => new Promise(() => {})),
      };
      const cleanup = spyOnResumeCleanup(manager);

      try {
        const login = manager.loginMcpServer("session-auth-timeout", "demo");
        const rejection = expect(login).rejects.toThrow("MCP auth resume timed out after 60s");
        await vi.advanceTimersByTimeAsync(60_000);
        await rejection;

        expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
        expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
        expect(manager.isSessionBusy("session-auth-timeout")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    }

    // resume failure case
    {
      const manager = createManager();
      const resumeError = new Error("MCP auth resume failed");
      manager.backend = {
        resumeSession: vi.fn().mockRejectedValue(resumeError),
      };
      const cleanup = spyOnResumeCleanup(manager);

      await expect(manager.loginMcpServer("session-auth-failure", "demo")).rejects.toBe(resumeError);

      expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
      expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
      expect(manager.isSessionBusy("session-auth-failure")).toBe(false);
    }
  });

  it("rejects MCP OAuth for servers not configured on the session", async () => {
    const manager = createManager();
    const resumeSession = vi.fn();
    manager.backend = { resumeSession };

    await expect(manager.loginMcpServer("session-auth-missing", "ado"))
      .rejects.toThrow('MCP server "ado" is not configured for this session');
    expect(resumeSession).not.toHaveBeenCalled();
  });
});

describe("SessionManager warmSession", () => {
  function createManager() {
    const db = setupTestDb();
    return new SessionManager({
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
      clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
    }) as any;
  }

  it("does not call setModel on the resumed session", async () => {
    const manager = createManager();
    const resumedSession = {
      setModel: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    const cleanup = spyOnResumeCleanup(manager);
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(resumedSession) };

    await manager.warmSession("session-warm-1");

    expect(resumedSession.setModel).not.toHaveBeenCalled();
    expect(manager.sessionObjects.get("session-warm-1")).toBe(resumedSession);
    expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
    expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
  });

  it("keeps a warmed session when the best-effort MCP probe rejects", async () => {
    const manager = createManager();
    const probeError = new Error("probe failed");
    const resumedSession = {
      listMcpServers: vi.fn().mockRejectedValue(probeError),
    };
    const cleanup = spyOnResumeCleanup(manager);
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(resumedSession) };

    await expect(manager.warmSession("session-warm-probe-failure")).resolves.toBeUndefined();
    await Promise.resolve();

    expect(resumedSession.listMcpServers).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.get("session-warm-probe-failure")).toBe(resumedSession);
    expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
    expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
  });

  it("releases warm resume cleanup exactly once on timeout or resume failure", async () => {
    // timeout case
    {
      vi.useFakeTimers();
      const manager = createManager();
      manager.backend = {
        resumeSession: vi.fn(() => new Promise(() => {})),
      };
      const cleanup = spyOnResumeCleanup(manager);

      try {
        const warming = manager.warmSession("session-warm-timeout");
        const rejection = expect(warming).rejects.toThrow("warmSession timed out after 60s");
        await vi.advanceTimersByTimeAsync(60_000);
        await rejection;

        expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
        expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
        expect(manager.isSessionBusy("session-warm-timeout")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    }

    // resume failure case
    {
      const manager = createManager();
      const resumeError = new Error("warm resume failed");
      manager.backend = {
        resumeSession: vi.fn().mockRejectedValue(resumeError),
      };
      const cleanup = spyOnResumeCleanup(manager);

      await expect(manager.warmSession("session-warm-failure")).rejects.toBe(resumeError);

      expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
      expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
      expect(manager.isSessionBusy("session-warm-failure")).toBe(false);
    }
  });

  it("coalesces concurrent warm resumes for the same session", async () => {
    const manager = createManager();
    const resumedSession = {
      setModel: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    let resolveResume!: (session: typeof resumedSession) => void;
    const resumeSession = vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
      resolveResume = resolve;
    }));
    manager.backend = { resumeSession };

    const firstWarm = manager.warmSession("session-warm-race");
    const secondWarm = manager.warmSession("session-warm-race");

    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledTimes(1));
    resolveResume(resumedSession);
    await Promise.all([firstWarm, secondWarm]);

    expect(manager.sessionObjects.get("session-warm-race")).toBe(resumedSession);
  });

  it("skips warm when the session is already running", async () => {
    const manager = createManager();
    const resumeSession = vi.fn();
    manager.backend = { resumeSession };
    manager.sessionRuns.set("session-running", {
      state: "busy",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    await expect(manager.warmSession("session-running")).resolves.toBeUndefined();

    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("discards a superseded warm resume without evicting the newer cached session", async () => {
    const manager = createManager();
    const resumedSession = {
      disconnect: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    const newerSession = {
      disconnect: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    let resolveResume!: (session: typeof resumedSession) => void;
    manager.backend = {
      resumeSession: vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
        resolveResume = resolve;
      })),
    };

    const warming = manager.warmSession("session-warm-superseded");
    await vi.waitFor(() => expect(manager.backend.resumeSession).toHaveBeenCalledTimes(1));
    // A newer cached session arrives before the in-flight resume resolves.
    manager.sessionObjects.set("session-warm-superseded", newerSession);

    resolveResume(resumedSession);
    await warming;
    await manager._drainCacheQueue();

    expect(manager.sessionObjects.get("session-warm-superseded")).toBe(newerSession);
    expect(resumedSession.disconnect).not.toHaveBeenCalled();
    expect(newerSession.disconnect).not.toHaveBeenCalled();
  });
});
