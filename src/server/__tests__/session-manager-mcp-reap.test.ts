import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";

// Regression coverage for the bounded session cache that bounds how many warm
// sessions (and therefore MCP server subprocesses) the Bridge keeps alive.
//
// Empirically (against the live Copilot host) `session.disconnect()` disposes
// the host-side session and terminates its MCP server child processes while
// preserving on-disk history. The leak was not un-disconnected sessions but an
// unbounded cache: idle sessions were never evicted, so their MCP servers were
// never reaped. enforceSessionCacheLimit evicts least-recently-used idle
// sessions (calling disconnect, which reaps) once the cap is exceeded.
function createManager(): any {
  const db = setupTestDb();
  return new SessionManager({
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: { findTaskBySessionId: vi.fn().mockReturnValue(null) } as any,
    settingsStore: {
      getMcpServers: () => ({}),
      getSettings: () => ({ model: "claude-opus-4.7" }),
    } as any,
    config: { sessionMcpServers: {} },
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
  }) as any;
}

const fakeSession = () => ({ disconnect: vi.fn() });

describe("SessionManager eviction reaps via disconnect", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("disconnects the cached session on eviction (reaps its MCP host)", () => {
    const manager = createManager();
    const session = fakeSession();
    manager.sessionObjects.set("s1", session);

    manager.evictAllCachedSessions();

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("s1")).toBe(false);
  });
});

describe("SessionManager bounded session cache", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("evicts the least-recently-cached idle session when over the cap", () => {
    const manager = createManager();
    manager.maxCachedSessions = 2;
    const s1 = fakeSession();
    const s2 = fakeSession();
    const s3 = fakeSession();
    manager.sessionObjects.set("s1", s1); // oldest
    manager.sessionObjects.set("s2", s2);
    manager.sessionObjects.set("s3", s3); // newest / just cached

    manager.enforceSessionCacheLimit("s3");

    expect(manager.sessionObjects.has("s1")).toBe(false);
    expect(manager.sessionObjects.has("s2")).toBe(true);
    expect(manager.sessionObjects.has("s3")).toBe(true);
    expect(s1.disconnect).toHaveBeenCalledTimes(1);
  });

  it("never evicts an active session even when over the cap", () => {
    const manager = createManager();
    manager.maxCachedSessions = 1;
    const s1 = fakeSession();
    const s2 = fakeSession();
    manager.sessionObjects.set("s1", s1);
    manager.sessionObjects.set("s2", s2);
    // s1 is the oldest but busy, so it must be protected from cache eviction.
    manager.sessionRuns.set("s1", { state: "busy", startedAt: Date.now(), lastEventAt: Date.now() });

    manager.enforceSessionCacheLimit("s2");

    expect(manager.sessionObjects.has("s1")).toBe(true);
    expect(manager.sessionObjects.has("s2")).toBe(true);
    expect(s1.disconnect).not.toHaveBeenCalled();
  });

  it("does nothing when the cache is within the cap", () => {
    const manager = createManager();
    manager.maxCachedSessions = 16;
    const s1 = fakeSession();
    manager.sessionObjects.set("s1", s1);

    manager.enforceSessionCacheLimit("s1");

    expect(manager.sessionObjects.has("s1")).toBe(true);
    expect(s1.disconnect).not.toHaveBeenCalled();
  });

  it("caps the cache as sessions are cached, evicting the oldest idle entry", () => {
    const manager = createManager();
    manager.maxCachedSessions = 3;
    const sessions: Record<string, ReturnType<typeof fakeSession>> = {};
    for (let i = 0; i < 5; i++) {
      const id = `sess-${i}`;
      const session = fakeSession();
      sessions[id] = session;
      manager.cacheResumedSession(id, session);
    }
    // Only the 3 most-recently-cached survive; the 2 oldest were evicted+disconnected.
    expect(manager.sessionObjects.size).toBe(3);
    expect([...manager.sessionObjects.keys()]).toEqual(["sess-2", "sess-3", "sess-4"]);
    expect(sessions["sess-0"].disconnect).toHaveBeenCalledTimes(1);
    expect(sessions["sess-1"].disconnect).toHaveBeenCalledTimes(1);
    expect(sessions["sess-4"].disconnect).not.toHaveBeenCalled();
  });

  it("defaults the cap from BRIDGE_MAX_CACHED_SESSIONS when set", () => {
    vi.stubEnv("BRIDGE_MAX_CACHED_SESSIONS", "4");
    try {
      const manager = createManager();
      expect(manager.maxCachedSessions).toBe(4);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
