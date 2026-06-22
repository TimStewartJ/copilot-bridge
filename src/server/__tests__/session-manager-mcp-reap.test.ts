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

function retainedSize(manager: any): number {
  return manager.sessionObjects.size + manager.cleanupOwnership.size;
}

describe("SessionManager bounded session lifecycle", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("awaits disconnect before reporting a cached session evicted", async () => {
    const { manager } = createManager();
    const session = fakeSession();
    manager.sessionObjects.set("s1", session);

    await manager.evictAllCachedSessions();

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("s1")).toBe(false);
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("bounds repeated fresh task sessions from the scheduler creation path", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 2;
    const sessions: Array<FakeSession & { sessionId: string }> = [];
    manager.backend = {
      createSession: vi.fn(async () => {
        const session = fakeSession(`scheduled-${sessions.length}`) as FakeSession & { sessionId: string };
        sessions.push(session);
        return session;
      }),
    };

    for (let index = 0; index < 5; index++) {
      await manager.createTaskSession("task-1", "Scheduled task", [], [], "");
      expect(retainedSize(manager)).toBeLessThanOrEqual(2);
    }

    expect([...manager.sessionObjects.keys()]).toEqual(["scheduled-3", "scheduled-4"]);
    expect(sessions.slice(0, 3).every((session) => session.disconnect.mock.calls.length === 1)).toBe(true);
    expect(sessions.slice(3).every((session) => session.disconnect.mock.calls.length === 0)).toBe(true);
  });

  it("bounds repeated resumed-session insertion", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 3;
    const sessions = Array.from({ length: 7 }, () => fakeSession());

    for (let index = 0; index < sessions.length; index++) {
      await manager.cacheResumedSession(`resumed-${index}`, sessions[index]);
      expect(retainedSize(manager)).toBeLessThanOrEqual(3);
    }

    expect([...manager.sessionObjects.keys()]).toEqual(["resumed-4", "resumed-5", "resumed-6"]);
    expect(sessions.slice(0, 4).every((session) => session.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("retries a rejected disconnect before admitting the next session", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const first = {
      disconnect: vi.fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue(undefined),
    };

    await manager.cacheResumedSession("first", first);
    await manager.cacheResumedSession("second", fakeSession());

    expect(first.disconnect).toHaveBeenCalledTimes(2);
    expect(retainedSize(manager)).toBe(1);
    expect(manager.cumulativeCleanupFailures).toBe(0);
  });

  it("rejects admission when a victim cannot be reaped and retains failed cleanup ownership", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const stuck = { disconnect: vi.fn().mockRejectedValue(new Error("still running")) };
    const incoming = fakeSession();

    await manager.cacheResumedSession("stuck", stuck);
    await expect(manager.cacheResumedSession("incoming", incoming))
      .rejects.toThrow("admission blocked");

    expect(stuck.disconnect).toHaveBeenCalledTimes(2);
    expect(incoming.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({
      sessionId: "stuck",
      state: "failed",
      lastOutcome: "rejected",
    });
    expect(retainedSize(manager)).toBe(1);
    expect(manager.sessionObjects.has("incoming")).toBe(false);
  });

  it("admits a session when another idle victim can be reaped", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 2;
    const stuck = { disconnect: vi.fn().mockRejectedValue(new Error("still running")) };
    const reapable = fakeSession();

    await manager.cacheResumedSession("stuck", stuck);
    await manager.cacheResumedSession("reapable", reapable);
    await manager.cacheResumedSession("incoming", fakeSession());

    expect(stuck.disconnect).toHaveBeenCalledTimes(2);
    expect(reapable.disconnect).toHaveBeenCalledTimes(1);
    expect([...manager.sessionObjects.keys()]).toEqual(["incoming"]);
    expect(retainedSize(manager)).toBe(2);
  });

  it("times out disconnect attempts, retains ownership, and rejects the incoming session", async () => {
    vi.useFakeTimers();
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const stuck = { disconnect: vi.fn(() => new Promise<void>(() => {})) };
    const incoming = fakeSession();

    await manager.cacheResumedSession("stuck", stuck);
    const admission = manager.cacheResumedSession("incoming", incoming);
    const admissionError = admission.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_500);
    await expect(admissionError).resolves.toMatchObject({
      message: expect.stringContaining("admission blocked"),
    });

    expect(stuck.disconnect).toHaveBeenCalledTimes(2);
    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({
      sessionId: "stuck",
      state: "failed",
      lastOutcome: "timed-out",
    });
    expect(incoming.disconnect).toHaveBeenCalledTimes(1);
    expect(retainedSize(manager)).toBe(1);
  });

  it("serializes concurrent insertions while bounded cleanup is pending", async () => {
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

    const insertSecond = manager.cacheResumedSession("second", second);
    const insertThird = manager.cacheResumedSession("third", third);
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalledTimes(1));

    expect(second.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.has("third")).toBe(false);

    releaseFirst();
    await insertSecond;
    await insertThird;

    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect([...manager.sessionObjects.keys()]).toEqual(["third"]);
    expect(retainedSize(manager)).toBe(1);
  });

  it("tracks same-id replacement cleanup by session object identity", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 2;
    let releaseOld!: () => void;
    const oldSession = {
      disconnect: vi.fn(() => new Promise<void>((resolve) => {
        releaseOld = resolve;
      })),
    };
    const replacement = fakeSession();
    await manager.cacheResumedSession("same", oldSession);

    const replacing = manager.replaceCachedSession("same", oldSession, replacement);
    await vi.waitFor(() => expect(oldSession.disconnect).toHaveBeenCalledTimes(1));

    expect(manager.sessionObjects.get("same")).toBe(replacement);
    expect(manager.cleanupOwnership.get(oldSession)).toMatchObject({
      sessionId: "same",
      state: "pending",
    });
    expect(manager.cleanupOwnership.has(replacement)).toBe(false);

    releaseOld();
    await replacing;
    expect(manager.cleanupOwnership.has(oldSession)).toBe(false);
  });

  it("protects active, resuming, and model-switching sessions, then converges after protection ends", async () => {
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
    expect(resuming.disconnect).not.toHaveBeenCalled();
    expect(switching.disconnect).not.toHaveBeenCalled();

    manager.sessionRuns.delete("active");
    manager.resumingSessions.clear();
    manager.modelSwitchingSessions.clear();
    await manager.trimSessionCache("test protection ended");

    expect(retainedSize(manager)).toBe(1);
    expect([...manager.sessionObjects.keys()]).toEqual(["new"]);
  });

  it("records operation and cleanup state telemetry", async () => {
    const { manager, telemetryStore } = createManager({ telemetry: true });
    manager.maxCachedSessions = 1;
    manager.lastProcessTreeSampleAt = Date.now();
    await manager.cacheResumedSession("first", fakeSession());
    await manager.cacheResumedSession("second", fakeSession());

    const operations = telemetryStore!.querySpans({ name: "session.cache.operation" });
    const disconnects = telemetryStore!.querySpans({ name: "session.cache.disconnect" });

    expect(operations[0].metadata).toMatchObject({
      operation: "insert",
      outcome: "succeeded",
      max: 1,
      ready: 1,
      retained: 1,
      pendingCleanup: 0,
      failedCleanup: 0,
    });
    expect(disconnects[0].metadata).toMatchObject({
      outcome: "fulfilled",
      reason: "enforcing session cache limit",
    });
  });

  it("defaults the cap from BRIDGE_MAX_CACHED_SESSIONS", () => {
    vi.stubEnv("BRIDGE_MAX_CACHED_SESSIONS", "4");
    try {
      expect(createManager().manager.maxCachedSessions).toBe(4);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
