import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";

type FakeSession = {
  sessionId?: string;
  disconnect: ReturnType<typeof vi.fn>;
};

function fakeSession(sessionId?: string): FakeSession {
  return {
    ...(sessionId ? { sessionId } : {}),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function createManager(options: { telemetry?: boolean } = {}): {
  manager: any;
  telemetryStore?: ReturnType<typeof createTelemetryStore>;
} {
  const db = setupTestDb();
  const telemetryStore = options.telemetry ? createTelemetryStore(db) : undefined;
  const manager = new SessionManager({
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: {
      findTaskBySessionId: vi.fn().mockReturnValue(null),
      getTask: vi.fn().mockReturnValue(null),
    } as any,
    settingsStore: {
      getMcpServers: () => ({}),
      getSettings: () => ({ model: "claude-opus-4.7" }),
    } as any,
    telemetryStore,
    config: { sessionMcpServers: {} },
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
  }) as any;
  return { manager, telemetryStore };
}

describe("SessionManager bounded session lifecycle", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("awaits cleanup for explicit evict-all operations", async () => {
    const { manager } = createManager();
    const session = fakeSession();
    manager.sessionObjects.set("s1", session);

    await manager.evictAllCachedSessions();

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("s1")).toBe(false);
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("keeps fresh scheduled-session creation responsive while cleanup runs independently", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 2;
    let releaseOldest!: () => void;
    const sessions: Array<FakeSession & { sessionId: string }> = [];
    manager.backend = {
      createSession: vi.fn(async () => {
        const session = fakeSession(`scheduled-${sessions.length}`) as FakeSession & { sessionId: string };
        if (sessions.length === 0) {
          session.disconnect.mockImplementation(() => new Promise<void>((resolve) => {
            releaseOldest = resolve;
          }));
        }
        sessions.push(session);
        return session;
      }),
    };

    await manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await vi.waitFor(() => expect(sessions[0].disconnect).toHaveBeenCalledTimes(1));

    expect([...manager.sessionObjects.keys()]).toEqual(["scheduled-1", "scheduled-2"]);
    expect(manager.cleanupOwnership.has(sessions[0])).toBe(true);

    releaseOldest();
    await manager._drainCacheQueue();
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("returns concurrent cache insertions before a hung disconnect finishes", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    let releaseFirst!: () => void;
    const first = {
      disconnect: vi.fn(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })),
    };
    const second = fakeSession();
    const third = fakeSession();
    await manager.cacheResumedSession("first", first);

    await manager.cacheResumedSession("second", second);
    await manager.cacheResumedSession("third", third);

    expect([...manager.sessionObjects.keys()]).toEqual(["third"]);
    expect(manager.cleanupOwnership.has(first)).toBe(true);
    expect(manager.cleanupOwnership.has(second)).toBe(true);
    expect(second.disconnect).not.toHaveBeenCalled();

    releaseFirst();
    await manager._drainCacheQueue();
    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("tracks same-id replacement cleanup without delaying the replacement", async () => {
    const { manager } = createManager();
    let releaseOld!: () => void;
    const oldSession = {
      disconnect: vi.fn(() => new Promise<void>((resolve) => {
        releaseOld = resolve;
      })),
    };
    const replacement = fakeSession();
    await manager.cacheResumedSession("same", oldSession);

    await manager.replaceCachedSession("same", oldSession, replacement);

    expect(manager.sessionObjects.get("same")).toBe(replacement);
    expect(manager.cleanupOwnership.get(oldSession)).toMatchObject({
      sessionId: "same",
      state: "pending",
    });
    releaseOld();
    await manager._drainCacheQueue();
    expect(manager.cleanupOwnership.has(oldSession)).toBe(false);
  });

  it("retries a rejected disconnect in the cleanup worker", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const first = {
      disconnect: vi.fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue(undefined),
    };

    await manager.cacheResumedSession("first", first);
    await manager.cacheResumedSession("second", fakeSession());
    await manager._drainCacheQueue();

    expect(first.disconnect).toHaveBeenCalledTimes(2);
    expect(manager.cleanupOwnership.size).toBe(0);
    expect(manager.cumulativeCleanupFailures).toBe(0);
  });

  it("retains failed cleanup ownership and blocks new SDK session creation", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const stuck = { disconnect: vi.fn().mockRejectedValue(new Error("still running")) };
    await manager.cacheResumedSession("stuck", stuck);
    await manager.cacheResumedSession("next", fakeSession());
    await manager._drainCacheQueue();

    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({
      sessionId: "stuck",
      state: "failed",
      lastOutcome: "rejected",
    });
    const createSession = vi.fn();
    manager.backend = { createSession };
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toThrow("cleanup failure");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("retains timed-out cleanup ownership without blocking the cache insertion", async () => {
    vi.useFakeTimers();
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const stuck = { disconnect: vi.fn(() => new Promise<void>(() => {})) };
    await manager.cacheResumedSession("stuck", stuck);

    await manager.cacheResumedSession("next", fakeSession());
    expect([...manager.sessionObjects.keys()]).toEqual(["next"]);

    const drain = manager._drainCacheQueue();
    await vi.advanceTimersByTimeAsync(10_500);
    await drain;
    expect(stuck.disconnect).toHaveBeenCalledTimes(2);
    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({
      sessionId: "stuck",
      state: "failed",
      lastOutcome: "timed-out",
    });
  });

  it("blocks new SDK sessions when the cleanup backlog reaches its cap", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    manager.maxPendingSessionCleanups = 1;
    let release!: () => void;
    const first = {
      disconnect: vi.fn(() => new Promise<void>((resolve) => {
        release = resolve;
      })),
    };
    await manager.cacheResumedSession("first", first);
    await manager.cacheResumedSession("second", fakeSession());
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalledTimes(1));

    const createSession = vi.fn();
    manager.backend = { createSession };
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toThrow("cleanup demand");
    expect(createSession).not.toHaveBeenCalled();

    release();
    await manager._drainCacheQueue();
  });

  it("reserves cleanup capacity across concurrent session creation", async () => {
    const { manager } = createManager();
    manager.maxPendingSessionCleanups = 1;
    let resolveCreate!: (session: FakeSession & { sessionId: string }) => void;
    const createSession = vi.fn(() => new Promise<FakeSession & { sessionId: string }>((resolve) => {
      resolveCreate = resolve;
    }));
    manager.backend = { createSession };

    const first = manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toThrow("cleanup demand");

    resolveCreate(fakeSession("created") as FakeSession & { sessionId: string });
    await first;
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("protects active, resuming, and model-switching sessions, then trims after protection ends", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const active = fakeSession();
    const resuming = fakeSession();
    const switching = fakeSession();
    manager.sessionObjects.set("active", active);
    manager.sessionObjects.set("resuming", resuming);
    manager.sessionObjects.set("switching", switching);
    manager.sessionRuns.set("active", { state: "busy", startedAt: Date.now(), lastEventAt: Date.now() });
    manager.resumingSessions.set("resuming", 1);
    manager.modelSwitchingSessions.add("switching");

    await manager.cacheResumedSession("new", fakeSession());
    expect(manager.sessionObjects.size).toBe(4);
    expect(active.disconnect).not.toHaveBeenCalled();

    manager.sessionRuns.delete("active");
    manager.resumingSessions.clear();
    manager.modelSwitchingSessions.clear();
    await manager.trimSessionCache("test protection ended");
    await manager._drainCacheQueue();

    expect([...manager.sessionObjects.keys()]).toEqual(["new"]);
    expect(active.disconnect).toHaveBeenCalledTimes(1);
    expect(resuming.disconnect).toHaveBeenCalledTimes(1);
    expect(switching.disconnect).toHaveBeenCalledTimes(1);
  });

  it("records state operations separately from cleanup duration", async () => {
    const { manager, telemetryStore } = createManager({ telemetry: true });
    manager.maxCachedSessions = 1;
    manager.lastProcessTreeSampleAt = Date.now();
    await manager.cacheResumedSession("first", fakeSession());
    await manager.cacheResumedSession("second", fakeSession());

    const operation = telemetryStore!.querySpans({ name: "session.cache.operation" })[0];
    expect(operation.metadata).toMatchObject({
      operation: "insert",
      outcome: "succeeded",
      ready: 1,
    });

    await manager._drainCacheQueue();
    const disconnect = telemetryStore!.querySpans({ name: "session.cache.disconnect" })[0];
    expect(disconnect.metadata).toMatchObject({
      outcome: "fulfilled",
      reason: "enforcing session cache limit",
    });
  });

  it("defaults limits from environment variables", () => {
    vi.stubEnv("BRIDGE_MAX_CACHED_SESSIONS", "4");
    vi.stubEnv("BRIDGE_MAX_PENDING_SESSION_CLEANUPS", "3");
    try {
      const { manager } = createManager();
      expect(manager.maxCachedSessions).toBe(4);
      expect(manager.maxPendingSessionCleanups).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
