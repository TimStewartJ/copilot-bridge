import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus, freezeLifecycleDeadlines, makeAgentSessionStub } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import type { AgentSessionEventHandler } from "../agent-backend/index.js";

function spyOnResumeCleanup(manager: any) {
  return {
    endSessionResume: vi.spyOn(manager, "endSessionResume"),
    flushPendingSessionEviction: vi.spyOn(manager, "flushPendingSessionEviction"),
  };
}

function diagnosticGate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["resolved", "rejected"])("does not emit diagnostics for a fast %s resume", async (outcome) => {
    vi.useFakeTimers();
    const manager = createManager();
    const backend = { diagnosticPing: vi.fn() };
    manager.backend = backend;
    const record = vi.spyOn(manager, "recordSpan");
    const session = makeAgentSessionStub({});
    const error = new Error("private provider error");
    const work = outcome === "resolved" ? Promise.resolve(session) : Promise.reject(error);
    const result = manager.resumeAgentSessionWithTimeout(backend, "fast", work, "timeout", "reload");
    if (outcome === "resolved") await expect(result).resolves.toBe(session);
    else await expect(result).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.diagnosticPing).not.toHaveBeenCalled();
    expect(record.mock.calls.filter(([name]) => name === "session.resume.diagnostic")).toEqual([]);
  });

  it("records a slow resume and failed diagnostic ping without triggering recovery", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const gate = diagnosticGate<ReturnType<typeof makeAgentSessionStub>>();
    const backend = {
      diagnosticPing: vi.fn().mockRejectedValue(new Error("private credential detail")),
      getConnectionStatus: () => ({ state: "connected", pid: 4242, lastDisconnect: { detail: "private" } }),
    };
    manager.backend = backend;
    const recover = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    const record = vi.spyOn(manager, "recordSpan");
    const result = manager.resumeAgentSessionWithTimeout(backend, "slow", gate.promise, "timeout", "warmup");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(backend.diagnosticPing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.diagnosticPing).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith("session.resume.diagnostic", 30_000, "slow", expect.objectContaining({
      purpose: "warmup", pid: 4242, outcome: "slow", timedOut: false,
      attemptId: expect.any(String), generation: expect.any(Number),
      connection: "connected", wrapperEnded: false,
    }));
    expect(record).toHaveBeenCalledWith("session.resume.diagnostic", 30_000, "slow", expect.objectContaining({
      outcome: "ping", ping: "failed",
    }));
    expect(recover).not.toHaveBeenCalled();
    gate.resolve(makeAgentSessionStub({}));
    await result;
    expect(record).toHaveBeenCalledWith("session.resume.diagnostic", 30_000, "slow", expect.objectContaining({
      outcome: "backend-resolved", wrapperEnded: false,
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("private");
  });

  it("captures timeout before recovery at exactly 60s even if diagnostics fail or hang", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const gate = diagnosticGate<ReturnType<typeof makeAgentSessionStub>>();
    const ping = diagnosticGate<string>();
    const backend = {
      diagnosticPing: vi.fn(() => ping.promise),
      getConnectionStatus: () => { throw new Error("private snapshot detail"); },
    };
    manager.backend = backend;
    const recover = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    const record = vi.spyOn(manager, "recordSpan");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = manager.resumeAgentSessionWithTimeout(backend, "timeout", gate.promise, "original timeout", "reload");
    const rejected = expect(result).rejects.toThrow("original timeout");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(recover).toHaveBeenCalledOnce();
    const index = record.mock.calls.findIndex(([, , , metadata]) =>
      typeof metadata === "object" && metadata !== null && "outcome" in metadata && metadata.outcome === "timeout");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(record.mock.invocationCallOrder[index]).toBeLessThan(recover.mock.invocationCallOrder[0]);
    expect(record.mock.calls[index]).toEqual([
      "session.resume.diagnostic", 60_000, "timeout", expect.objectContaining({ connection: "unavailable", timedOut: true }),
    ]);
    gate.reject(new Error("private late SDK failure"));
    ping.resolve("timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledWith("session.resume.diagnostic", 60_000, "timeout", expect.objectContaining({
      outcome: "backend-rejected", timedOut: true, wrapperEnded: true,
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("private");
    warning.mockRestore();
  });

  it.each(["resolved", "rejected"])("attributes backend %s after fencing to the original attempt", async (outcome) => {
    vi.useFakeTimers();
    const manager = createManager();
    const gate = diagnosticGate<ReturnType<typeof makeAgentSessionStub>>();
    const backend = { getConnectionStatus: () => ({ state: "connected", pid: 4242 }) };
    manager.backend = backend;
    const record = vi.spyOn(manager, "recordSpan");
    const result = manager.resumeAgentSessionWithTimeout(backend, "fenced", gate.promise, "timeout", "send");
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    const generation = manager.backendGeneration;
    const fence = manager.getBackendFence(backend);
    fence.confirmed = true;
    for (const waiter of fence.waiters) waiter();
    manager.backend = { getConnectionStatus: () => ({ state: "connected", pid: 9999 }) };
    manager.backendGeneration++;
    await rejected;
    expect(record.mock.calls.some(([, , , metadata]) =>
      typeof metadata === "object" && metadata !== null && "outcome" in metadata && metadata.outcome === "backend-rejected")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    if (outcome === "resolved") gate.resolve(makeAgentSessionStub({}));
    else gate.reject(new Error("private late backend failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledWith("session.resume.diagnostic", 31_000, "fenced", expect.objectContaining({
      outcome: `backend-${outcome}`, pid: 4242, generation, timedOut: false, wrapperEnded: true,
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(record.mock.calls.filter(([name]) => name === "session.resume.diagnostic")).toHaveLength(3);
    expect(JSON.stringify(record.mock.calls)).not.toContain("private");
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
    manager.mcpStatus.set("session-1", {
      servers: [{ name: "stale", status: "failed" }],
      complete: true,
    });

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
    expect(servers).toEqual([expect.objectContaining({ name: "demo", status: "connected", source: "settings", provenance: "probe", observedAt: expect.any(String) })]);
    expect(resumedSession.listMcpServers).toHaveBeenCalledTimes(1);
    expect(cleanup.endSessionResume).toHaveBeenCalledTimes(1);
    expect(cleanup.flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    // Resume must NOT call setModel — existing sessions keep their persisted SDK model.
    expect(resumedSession.setModel).not.toHaveBeenCalled();
  });

  it("invalidates only sessions linked to the task and defers busy sessions", async () => {
    const manager = createManager();
    manager.deps.taskStore.listSessionIdsForTask = vi.fn().mockReturnValue([
      "busy-session",
      "idle-session",
    ]);
    manager.sessionObjects.set("busy-session", makeAgentSessionStub({}));
    manager.sessionObjects.set("idle-session", makeAgentSessionStub({}));
    manager.sessionRuns.set("busy-session", {
      state: "busy",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });
    const mark = vi.spyOn(manager, "markCachedSessionForEviction");

    const count = manager.invalidateTaskSessionConfig("task-1", "agent changed");
    await manager._drainCacheQueue();

    expect(count).toBe(2);
    expect(mark).toHaveBeenCalledWith("busy-session", "agent changed");
    expect(mark).toHaveBeenCalledWith("idle-session", "agent changed");
    expect(manager.pendingSessionEvictions.has("busy-session")).toBe(true);
    expect(manager.sessionObjects.has("idle-session")).toBe(false);
    expect(manager.sessionObjects.has("busy-session")).toBe(true);
  });

  it("waits for the old native session to disconnect before resuming the same ID", async () => {
    freezeLifecycleDeadlines();
    const manager = createManager();
    let finishDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      finishDisconnect = resolve;
    });
    const oldSession = makeAgentSessionStub({ disconnect: vi.fn(() => disconnectGate) });
    const resumedSession = makeAgentSessionStub({
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const resumeSession = vi.fn().mockResolvedValue(resumedSession);
    manager.backend = { resumeSession };
    manager.sessionObjects.set("session-detaching", oldSession);

    const reloading = manager.reloadSession("session-detaching");
    try {
      await vi.waitFor(() => expect(oldSession.disconnect).toHaveBeenCalledOnce());
      expect(resumeSession).not.toHaveBeenCalled();
      expect(manager.isSessionBusy("session-detaching")).toBe(true);

      finishDisconnect();
      await expect(reloading).resolves.toEqual([]);
      expect(manager.sessionObjects.get("session-detaching")).toBe(resumedSession);
      expect(resumeSession).toHaveBeenCalledOnce();
    } finally {
      finishDisconnect();
      await reloading;
      await manager._drainCacheQueue();
    }
  });

  it("does not resume or clear MCP state when the old session cannot be disconnected", async () => {
    const manager = createManager();
    const oldSession = makeAgentSessionStub({
      disconnect: vi.fn().mockRejectedValue(new Error("detach failed")),
    });
    const resumeSession = vi.fn().mockResolvedValue(makeAgentSessionStub({
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    }));
    const mcpState = { servers: [{ name: "demo", status: "connected" }], complete: true };
    manager.backend = { resumeSession };
    manager.sessionObjects.set("session-detach-failure", oldSession);
    manager.mcpStatus.set("session-detach-failure", mcpState);

    await expect(manager.reloadSession("session-detach-failure"))
      .rejects.toThrow("could not be reaped while reloading session");

    expect(resumeSession).not.toHaveBeenCalled();
    expect(manager.mcpStatus.get("session-detach-failure")).toBe(mcpState);
    expect(manager.isSessionBusy("session-detach-failure")).toBe(false);
  });

  it("releases the resume lifecycle exactly once when reload times out", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    let resolveResume!: (session: { disconnect: ReturnType<typeof vi.fn> }) => void;
    const resumeSession = vi.fn(() => new Promise<{ disconnect: ReturnType<typeof vi.fn> }>((resolve) => {
      resolveResume = resolve;
    }));
    const cleanup = spyOnResumeCleanup(manager);
    const handleBackendDisconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    manager.backend = { resumeSession };

    try {
      const reloading = manager.reloadSession("session-timeout");
      const rejection = expect(reloading).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;

      expect(handleBackendDisconnect).toHaveBeenCalledWith(
        manager.backend,
        expect.objectContaining({
          reason: "rpc-timeout",
          detail: expect.stringContaining("session-timeout"),
        }),
      );
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

  it("blocks another resume until a timed-out resume finishes late cleanup", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const lateSession = makeAgentSessionStub({ disconnect: vi.fn() });
    const recoveredSession = {
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    let resolveFirstResume!: (session: typeof lateSession) => void;
    const resumeSession = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof lateSession>((resolve) => {
        resolveFirstResume = resolve;
      }))
      .mockResolvedValueOnce(recoveredSession);
    const handleBackendDisconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    manager.backend = { resumeSession };

    try {
      const firstReload = manager.reloadSession("session-timeout-race");
      const firstRejection = expect(firstReload).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await firstRejection;

      expect(handleBackendDisconnect).toHaveBeenCalledOnce();
      // Only the timed-out session is held back; the backend itself stays available.
      expect(manager.getBackendUnavailableReason()).toBeUndefined();
      await expect(manager.reloadSession("session-timeout-race"))
        .rejects.toThrow("Agent backend is reconnecting");
      expect(resumeSession).toHaveBeenCalledTimes(1);

      resolveFirstResume(lateSession);
      await vi.advanceTimersByTimeAsync(0);
      await manager._drainCacheQueue();
      expect(lateSession.disconnect).toHaveBeenCalledTimes(1);

      await expect(manager.reloadSession("session-timeout-race")).resolves.toEqual([]);
      expect(resumeSession).toHaveBeenCalledTimes(2);
      expect(manager.sessionObjects.get("session-timeout-race")).toBe(recoveredSession);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a backend that still answers after one slow resume and fails only that request", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const lateSession = makeAgentSessionStub({ disconnect: vi.fn() });
    let resolveResume!: (session: typeof lateSession) => void;
    const backend = {
      resumeSession: vi.fn(() => new Promise<typeof lateSession>((resolve) => { resolveResume = resolve; })),
      probeHealth: vi.fn().mockResolvedValue(true),
    };
    const handleBackendDisconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    manager.backend = backend;

    try {
      const reload = manager.reloadSession("session-slow");
      const rejection = expect(reload).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;

      expect(backend.probeHealth).toHaveBeenCalledWith(undefined, expect.stringMatching(/^rpc-timeout: .*session-slow/));
      expect(handleBackendDisconnect).not.toHaveBeenCalled();
      expect(manager.getBackendUnavailableReason()).toBeUndefined();
      await expect(manager.reloadSession("session-slow")).rejects.toThrow("reconnecting");

      resolveResume(lateSession);
      await vi.advanceTimersByTimeAsync(0);
      await manager._drainCacheQueue();
      expect(lateSession.disconnect).toHaveBeenCalledOnce();
      expect(manager.settlingTimedOutSessionResumes.size).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handleBackendDisconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["the ping fails", false],
    ["the ping rejects", "reject"],
  ] as const)("recovers the backend after a slow resume when %s", async (_label, probe) => {
    vi.useFakeTimers();
    const manager = createManager();
    const backend = {
      resumeSession: vi.fn(() => new Promise<never>(() => {})),
      probeHealth: probe === "reject" ? vi.fn().mockRejectedValue(new Error("gone")) : vi.fn().mockResolvedValue(probe),
    };
    const handleBackendDisconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    manager.backend = backend;

    try {
      const rejection = expect(manager.reloadSession("session-dead")).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      expect(handleBackendDisconnect).toHaveBeenCalledOnce();
      expect(handleBackendDisconnect).toHaveBeenCalledWith(backend, expect.objectContaining({
        reason: "rpc-timeout", detail: expect.stringContaining("session-dead"),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a pingable backend when a second resume times out before the first settles", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const backend = {
      resumeSession: vi.fn(() => new Promise<never>(() => {})),
      probeHealth: vi.fn().mockResolvedValue(true),
    };
    const handleBackendDisconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    manager.backend = backend;

    try {
      const first = expect(manager.reloadSession("session-stuck-1")).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10_000);
      const second = expect(manager.reloadSession("session-stuck-2")).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(50_000);
      await first;
      expect(handleBackendDisconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      await second;
      expect(backend.probeHealth).toHaveBeenCalledOnce();
      expect(handleBackendDisconnect).toHaveBeenCalledOnce();
      expect(handleBackendDisconnect).toHaveBeenCalledWith(backend, expect.objectContaining({
        detail: expect.stringContaining("session-stuck-2"),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a pingable backend when a timed-out resume never settles", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const backend = {
      resumeSession: vi.fn(() => new Promise<never>(() => {})),
      probeHealth: vi.fn().mockResolvedValue(true),
    };
    const handleBackendDisconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    manager.backend = backend;

    try {
      const rejection = expect(manager.reloadSession("session-never")).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(handleBackendDisconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(handleBackendDisconnect).toHaveBeenCalledWith(backend, expect.objectContaining({
        reason: "rpc-timeout", detail: expect.stringContaining("never settled for session session-never"),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when fencing is unavailable after a timed-out resume", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const staleLateSession = makeAgentSessionStub({ disconnect: vi.fn() });
    const recoveredSession = {
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    let resolveFirstResume!: (session: typeof staleLateSession) => void;
    const fence = vi.fn().mockRejectedValue(new Error("process still alive"));
    const resumeSession = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof staleLateSession>((resolve) => {
        resolveFirstResume = resolve;
      }))
      .mockResolvedValueOnce(recoveredSession);
    manager.backend = { resumeSession, fence };

    try {
      const firstReload = manager.reloadSession("session-timeout-expiry");
      const firstRejection = expect(firstReload).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await firstRejection;

      await vi.advanceTimersByTimeAsync(0);
      await expect(manager.reloadSession("session-timeout-expiry")).rejects.toThrow("recovery is blocked");
      expect(manager.sessionObjects.has("session-timeout-expiry")).toBe(false);
      expect(manager.settlingTimedOutSessionResumes.has("session-timeout-expiry")).toBe(true);
      expect(resumeSession).toHaveBeenCalledOnce();

      resolveFirstResume(staleLateSession);
      await vi.advanceTimersByTimeAsync(0);
      await manager._drainCacheQueue();

      expect(staleLateSession.disconnect).not.toHaveBeenCalled();
      expect(manager.sessionObjects.has("session-timeout-expiry")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences the backend before starting a replacement after a timed-out resume", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    let resolveFence!: () => void;
    const fence = vi.fn(() => new Promise<void>((resolve) => {
      resolveFence = resolve;
    }));
    const recoveredSession = {
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    const nextBackend = {
      start: vi.fn().mockResolvedValue(undefined),
      resumeSession: vi.fn().mockResolvedValue(recoveredSession),
    };
    const resumeSession = vi.fn(() => new Promise<never>(() => {}));
    const backend = { resumeSession, fence };
    manager.backend = backend;
    manager.deps.createBackend = vi.fn(() => nextBackend);

    try {
      const reloading = manager.reloadSession("session-timeout-recovery");
      const rejection = expect(reloading).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;

      expect(fence).toHaveBeenCalledOnce();
      expect(nextBackend.start).not.toHaveBeenCalled();
      await expect(manager.reloadSession("session-timeout-recovery"))
        .rejects.toThrow("Agent backend is reconnecting");

      resolveFence();
      await vi.waitFor(() => expect(nextBackend.start).toHaveBeenCalledOnce());
      expect(manager.backend).toBe(nextBackend);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a superseded backend arm a resume barrier", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const staleLateSession = makeAgentSessionStub({ disconnect: vi.fn() });
    const recoveredSession = {
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    let resolveFirstResume!: (session: typeof staleLateSession) => void;
    const staleBackend = {
      resumeSession: vi.fn(() => new Promise<typeof staleLateSession>((resolve) => {
        resolveFirstResume = resolve;
      })),
    };
    const recoveredBackend = {
      resumeSession: vi.fn().mockResolvedValue(recoveredSession),
    };
    manager.backend = staleBackend;

    try {
      const firstReload = manager.reloadSession("session-backend-replaced");
      await vi.advanceTimersByTimeAsync(0);
      manager.backend = recoveredBackend;

      const firstRejection = expect(firstReload).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await firstRejection;

      await expect(manager.reloadSession("session-backend-replaced")).resolves.toEqual([]);
      expect(recoveredBackend.resumeSession).toHaveBeenCalledTimes(1);

      resolveFirstResume(staleLateSession);
      await vi.advanceTimersByTimeAsync(0);
      await manager._drainCacheQueue();

      expect(staleLateSession.disconnect).not.toHaveBeenCalled();
      expect(manager.sessionObjects.get("session-backend-replaced")).toBe(recoveredSession);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the barrier and recovers the backend when late cleanup cannot finish", async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const lateSession = makeAgentSessionStub({
      disconnect: vi.fn(() => new Promise(() => {})),
    });
    let resolveResume!: (session: typeof lateSession) => void;
    const backend = {
      resumeSession: vi.fn(() => new Promise<typeof lateSession>((resolve) => {
        resolveResume = resolve;
      })),
    };
    const handleBackendDisconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
    manager.backend = backend;

    try {
      const firstReload = manager.reloadSession("session-cleanup-timeout");
      const firstRejection = expect(firstReload).rejects.toThrow("reloadSession timed out after 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await firstRejection;

      resolveResume(lateSession);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(handleBackendDisconnect).toHaveBeenCalledWith(
        backend,
        expect.objectContaining({
          reason: "rpc-timeout",
          detail: expect.stringContaining("session-cleanup-timeout"),
        }),
      );
      await expect(manager.reloadSession("session-cleanup-timeout"))
        .rejects.toThrow("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a resume that resolves from a superseded backend", async () => {
    const manager = createManager();
    const staleSession = makeAgentSessionStub({ disconnect: vi.fn() });
    const recoveredSession = {
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    let resolveStaleResume!: (session: typeof staleSession) => void;
    const staleBackend = {
      resumeSession: vi.fn(() => new Promise<typeof staleSession>((resolve) => {
        resolveStaleResume = resolve;
      })),
    };
    const recoveredBackend = {
      resumeSession: vi.fn().mockResolvedValue(recoveredSession),
    };
    manager.backend = staleBackend;

    const staleReload = manager.reloadSession("session-pre-timeout-replacement");
    await vi.waitFor(() => expect(staleBackend.resumeSession).toHaveBeenCalledTimes(1));
    manager.backend = recoveredBackend;
    resolveStaleResume(staleSession);

    await expect(staleReload).rejects.toThrow("Agent backend disconnected");
    expect(manager.sessionObjects.has("session-pre-timeout-replacement")).toBe(false);
    expect(staleSession.disconnect).not.toHaveBeenCalled();

    await expect(manager.reloadSession("session-pre-timeout-replacement")).resolves.toEqual([]);
    expect(manager.sessionObjects.get("session-pre-timeout-replacement")).toBe(recoveredSession);
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
      servers: [expect.objectContaining({ name: "demo", status: "needs-auth", source: "settings", provenance: "probe", sessionId: "session-auth" })],
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
      servers: [expect.objectContaining({ name: "demo", status: "pending", source: "settings", provenance: "probe", sessionId: "session-auth-cold" })],
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
  function createManager(env: Record<string, string | undefined> = {}) {
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
      clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "", ...env },
    }) as any;
  }

  it.each([undefined, "", "false", " FALSE "])("keeps passive resume events when the switch is %s", async (setting) => {
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: setting });
    const resume = vi.fn().mockResolvedValue(makeAgentSessionStub({}));
    manager.backend = { id: "copilot", resumeSession: resume };

    await manager.warmSession("passive-default", { source: "chat-open" });

    expect(resume.mock.calls[0][1]).not.toHaveProperty("suppressResumeEvent");
  });

  it.each(["true", " TRUE "])("suppresses only the passive Copilot resume event when the switch is %s", async (setting) => {
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: setting });
    const session = makeAgentSessionStub({ setModel: vi.fn() });
    const resume = vi.fn().mockResolvedValue(session);
    const record = vi.spyOn(manager, "recordSpan");
    manager.backend = { id: "copilot", resumeSession: resume };

    await manager.warmSession("passive-enabled", { source: "chat-open" });

    expect(resume.mock.calls[0][1]).toMatchObject({
      suppressResumeEvent: true,
      pendingInteractionEvents: true,
      streaming: true,
      memory: { enabled: false },
    });
    expect(resume.mock.calls[0][1]).not.toHaveProperty("model");
    expect(resume.mock.calls[0][1]).not.toHaveProperty("reasoningEffort");
    expect(resume.mock.calls[0][1]).not.toHaveProperty("continuePendingWork");
    expect(session.setModel).not.toHaveBeenCalled();
    expect(manager.isSessionWarm("passive-enabled")).toBe(true);
    expect(record).toHaveBeenCalledWith("session.warm.coldResume", expect.any(Number), "passive-enabled", {
      source: "chat-open", resumeEventSuppressed: true,
    });
  });

  it.each(["yes", "1", "typo"])("warns and leaves suppression disabled for invalid switch %s", async (setting) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: setting });
    const resume = vi.fn().mockResolvedValue(makeAgentSessionStub({}));
    manager.backend = { id: "copilot", resumeSession: resume };

    await manager.warmSession("passive-invalid", { source: "chat-open" });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining("BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS must be true or false"));
    expect(resume.mock.calls[0][1]).not.toHaveProperty("suppressResumeEvent");
  });

  it("uses the injected environment rather than another deployment's process switch", async () => {
    vi.stubEnv("BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS", "true");
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: "false" });
    const resume = vi.fn().mockResolvedValue(makeAgentSessionStub({}));
    manager.backend = { id: "copilot", resumeSession: resume };

    await manager.warmSession("passive-isolated", { source: "chat-open" });

    expect(resume.mock.calls[0][1]).not.toHaveProperty("suppressResumeEvent");
  });

  it("leaves lifecycle and fork warmups unchanged with the switch enabled", async () => {
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: "true" });
    const resume = vi.fn().mockResolvedValue(makeAgentSessionStub({}));
    manager.backend = { id: "copilot", resumeSession: resume };

    await manager.warmSession("fork-warmup");

    expect(resume.mock.calls[0][1]).not.toHaveProperty("suppressResumeEvent");
  });

  it("does not apply the Copilot workaround to another backend", async () => {
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: "true" });
    const resume = vi.fn().mockResolvedValue(makeAgentSessionStub({}));
    manager.backend = { id: "other", resumeSession: resume };

    await manager.warmSession("passive-other", { source: "chat-open" });

    expect(resume.mock.calls[0][1]).not.toHaveProperty("suppressResumeEvent");
  });

  it("restores normal resume events on explicit reload after a suppressed warmup", async () => {
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: "true" });
    const session = makeAgentSessionStub({ disconnect: vi.fn(), listMcpServers: vi.fn().mockResolvedValue({ servers: [] }) });
    const reloaded = makeAgentSessionStub({ listMcpServers: vi.fn().mockResolvedValue({ servers: [] }) });
    const resume = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(reloaded);
    manager.backend = { id: "copilot", resumeSession: resume };

    await manager.warmSession("passive-reload", { source: "chat-open" });
    await manager.reloadSession("passive-reload");

    expect(resume.mock.calls[0][1]).toHaveProperty("suppressResumeEvent", true);
    expect(resume.mock.calls[1][1]).not.toHaveProperty("suppressResumeEvent");
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it.each([true, false])("keeps cached sends and cold-send resumes distinct after passive warming=%s", async (warmFirst) => {
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: "true" });
    const handlers = new Set<AgentSessionEventHandler>();
    const session = makeAgentSessionStub({
      on: vi.fn((handler: AgentSessionEventHandler) => {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      }),
      send: vi.fn(async () => {
        queueMicrotask(() => {
          for (const handler of handlers) {
            handler({ type: "assistant.message", data: { content: "Warm-cache reply" } });
            handler({ type: "session.idle", data: {} });
          }
        });
      }),
    });
    const resume = vi.fn().mockResolvedValue(session);
    manager.backend = { id: "copilot", resumeSession: resume };
    if (warmFirst) await manager.warmSession("passive-send", { source: "chat-open" });

    await manager._doWork("passive-send", "hello", manager.deps.eventBusRegistry.getOrCreateBus("passive-send"));

    expect(resume).toHaveBeenCalledOnce();
    if (warmFirst) expect(resume.mock.calls[0][1]).toHaveProperty("suppressResumeEvent", true);
    else expect(resume.mock.calls[0][1]).not.toHaveProperty("suppressResumeEvent");
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hello" }));
    expect(manager.isSessionBusy("passive-send")).toBe(false);
  });

  it("does not resume active work through the passive suppression path", async () => {
    const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: "true" });
    const resume = vi.fn();
    manager.backend = { id: "copilot", resumeSession: resume };
    manager.sessionRuns.set("passive-running", { state: "busy", startedAt: Date.now(), lastEventAt: Date.now() });

    await manager.warmSession("passive-running", { source: "chat-open" });

    expect(resume).not.toHaveBeenCalled();
  });

  it("keeps the 60-second recovery deadline for suppressed passive resumes", async () => {
    vi.useFakeTimers();
    try {
      const manager = createManager({ BRIDGE_SUPPRESS_PASSIVE_RESUME_EVENTS: "true" });
      const resume = vi.fn((_sessionId: string, _config: unknown) => new Promise<never>(() => {}));
      manager.backend = { id: "copilot", resumeSession: resume };
      const disconnect = vi.spyOn(manager, "handleBackendDisconnect").mockImplementation(() => {});
      const warming = manager.warmSession("passive-timeout", { source: "chat-open" });
      const rejected = expect(warming).rejects.toThrow("warmSession timed out after 60s");

      await vi.advanceTimersByTimeAsync(59_999);
      expect(disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;

      expect(disconnect).toHaveBeenCalledWith(manager.backend, expect.objectContaining({ reason: "rpc-timeout" }));
      expect(resume.mock.calls[0][1]).toHaveProperty("suppressResumeEvent", true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks deletion after waiting for session creation", async () => {
    const manager = createManager();
    const createdSession = makeAgentSessionStub({});
    let finishCreation!: (session: typeof createdSession) => void;
    const creation = new Promise<typeof createdSession>((resolve) => {
      finishCreation = resolve;
    });
    const resumeSession = vi.fn();
    manager.backend = { resumeSession };
    manager.pendingSessionCreations.set("session-deleting", creation);

    const warming = manager.warmSession("session-deleting");
    manager.deletingSessions.add("session-deleting");
    manager.sessionObjects.set("session-deleting", createdSession);
    finishCreation(createdSession);

    await expect(warming).rejects.toThrow("Session is being deleted");
    expect(resumeSession).not.toHaveBeenCalled();
  });

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

  it("keeps a warmed session without starting a best-effort MCP probe", async () => {
    const manager = createManager();
    const resumedSession = {
      listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    };
    const cleanup = spyOnResumeCleanup(manager);
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(resumedSession) };

    await expect(manager.warmSession("session-warm-probe-failure")).resolves.toBeUndefined();
    await Promise.resolve();

    expect(resumedSession.listMcpServers).not.toHaveBeenCalled();
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
