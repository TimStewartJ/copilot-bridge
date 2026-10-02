import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createSessionPromptProfileStore } from "../session-prompt-profile-store.js";
import { createBackgroundCommandStore } from "../background-command-store.js";
import { BACKGROUND_COMMAND_PROTECT_MS, queueStoppedCommandWake } from "../background-commands.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createTestBus, makeAgentSessionStub, makeTestDir, setupTestDb } from "./helpers.js";
import { join } from "node:path";

const MINUTE = 60_000;

type ShellState = "running" | "completed" | "gone";

function sessionWithCommand(sessionId: string, startedAt: number) {
  let state: ShellState = "running";
  return makeAgentSessionStub({
    sessionId,
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn(async () => ({
      tasks: state === "gone"
        ? []
        : [{
            kind: "shell" as const,
            id: "7",
            status: state,
            executionMode: "background",
            attachmentMode: "attached",
            startedAt: new Date(startedAt).toISOString(),
            description: "Test refresh",
            command: "pwsh -File refresh.ps1",
            pid: 4242,
          }],
    })),
    setCommand(next: ShellState) {
      state = next;
    },
  });
}

function createManager() {
  const db = setupTestDb();
  const backgroundCommandStore = createBackgroundCommandStore(db);
  const deferredPromptStore = createDeferredPromptStore(db);
  const onBackgroundCommandsStopped = vi.fn();
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
    sessionPromptProfileStore: createSessionPromptProfileStore(db),
    backgroundCommandStore,
    onBackgroundCommandsStopped,
    config: { sessionMcpServers: {} },
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
  }) as any;
  const stateRoot = makeTestDir("background-command-session-state");
  manager.getSessionStateDir = (sessionId: string) => join(stateRoot, sessionId);
  return { manager, db, backgroundCommandStore, deferredPromptStore, onBackgroundCommandsStopped };
}

function runningMarkers(db: ReturnType<typeof setupTestDb>, sessionId: string): number {
  return Number((db.prepare(
    "SELECT COUNT(*) AS n FROM background_command_markers WHERE sessionId = ? AND stoppedAt IS NULL",
  ).get(sessionId) as { n: number }).n);
}

describe("SessionManager and commands left running in a session's shell", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("keeps the session loaded and holds restarts while a recently started command runs", async () => {
    const { manager, db } = createManager();
    const waiting = sessionWithCommand("waiting", 0);
    const idle = makeAgentSessionStub({ sessionId: "idle", disconnect: vi.fn().mockResolvedValue(undefined) });
    await manager.cacheResumedSession("waiting", waiting);
    await manager.cacheResumedSession("idle", idle);

    expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    await manager.agentRegistry.refresh("waiting", "test");

    expect(manager.getLifecycleBlockingSessionCount()).toBe(1);
    expect(manager.getLifecycleBlockingSessionIds()).toEqual(["waiting"]);
    expect(manager.getActiveSessions()).toEqual([]);
    expect(runningMarkers(db, "waiting")).toBe(1);

    await expect(manager.evictIdleCachedSessions()).resolves.toEqual({ evictedSessions: 1, protectedSessions: 1 });
    expect(waiting.disconnect).not.toHaveBeenCalled();
    expect(idle.disconnect).toHaveBeenCalledTimes(1);
  });

  it("lets go once the command finishes, with nothing to report", async () => {
    const { manager, db, backgroundCommandStore, onBackgroundCommandsStopped } = createManager();
    const session = sessionWithCommand("s1", 0);
    await manager.cacheResumedSession("s1", session);
    await manager.agentRegistry.refresh("s1", "started");
    expect(manager.getLifecycleBlockingSessionCount()).toBe(1);

    session.setCommand("completed");
    await manager.agentRegistry.refresh("s1", "finished");

    expect(runningMarkers(db, "s1")).toBe(0);
    // Held a moment longer: the runtime is about to start the turn that tells the agent.
    expect(manager.getLifecycleBlockingSessionCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    await manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(1);
    expect(backgroundCommandStore.listStopped("s1")).toEqual([]);
    expect(onBackgroundCommandsStopped).not.toHaveBeenCalled();
    expect(manager.prepareTurnContext("s1").block).toBeUndefined();
  });

  it("outlasts the idle limit inside the protection window, then unloads and tells the agent once", async () => {
    const { manager, backgroundCommandStore, onBackgroundCommandsStopped } = createManager();
    manager.sessionCacheIdleTtlMs = 10 * MINUTE;
    const session = sessionWithCommand("s1", 0);
    await manager.cacheResumedSession("s1", session);
    await manager.agentRegistry.refresh("s1", "started");

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    await manager.trimSessionCache("test");
    await manager._drainCacheQueue();
    expect(manager.sessionObjects.has("s1")).toBe(true);
    expect(session.disconnect).not.toHaveBeenCalled();

    // A command that never finishes must not pin the session for good.
    await vi.advanceTimersByTimeAsync(BACKGROUND_COMMAND_PROTECT_MS - 30 * MINUTE + MINUTE);
    await manager.trimSessionCache("test");
    await manager._drainCacheQueue();
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.sessionObjects.has("s1")).toBe(false);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    expect(backgroundCommandStore.listStopped("s1")).toMatchObject([{ shellId: "7", stoppedBy: "unloaded" }]);
    expect(onBackgroundCommandsStopped).toHaveBeenCalledExactlyOnceWith("s1");

    const turn = manager.prepareTurnContext("s1");
    expect(turn.block).toContain("<bridge_notice>");
    expect(turn.block).toContain('shellId 7 "Test refresh"');
    expect(turn.block).toContain("stopped when the Bridge unloaded this session");
    // The runtime stopped it with the handle, so there is no process for the agent to look for.
    expect(turn.block).not.toContain("possibly still running");
    // A send that failed leaves the notice for the retry.
    expect(manager.prepareTurnContext("s1").block).toBe(turn.block);
    turn.commit();
    expect(manager.prepareTurnContext("s1").block).toBeUndefined();
  });

  it("does not claim a command was stopped when its runtime was lost", async () => {
    const { manager, backgroundCommandStore, onBackgroundCommandsStopped } = createManager();
    const session = sessionWithCommand("s1", 0);
    await manager.cacheResumedSession("s1", session);
    await manager.agentRegistry.refresh("s1", "started");
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    // The runtime died or was fenced: its handles are dropped without asking it to release anything.
    manager.backendTransition = { owner: {}, phase: "retiring" };
    await manager.dropCachedSessionsForLostBackend();
    await vi.advanceTimersByTimeAsync(1);

    expect(session.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.has("s1")).toBe(false);
    expect(backgroundCommandStore.listStopped("s1")).toMatchObject([{ shellId: "7", pid: 4242, stoppedBy: "runtime-lost" }]);
    expect(onBackgroundCommandsStopped).toHaveBeenCalledExactlyOnceWith("s1");
    const block = manager.prepareTurnContext("s1").block;
    expect(block).toContain('shellId 7 "Test refresh" (started 1970-01-01T00:00:00.000Z as process 4242, cut off when the agent runtime was lost, possibly still running)');
    expect(block).toContain("Before you rerun it, look for its process");
    expect(block).not.toContain("were stopped before they finished");
  });

  it("wakes the agent when a refresh unloads the session under a command it was waiting for", async () => {
    const { manager, backgroundCommandStore, deferredPromptStore, onBackgroundCommandsStopped } = createManager();
    onBackgroundCommandsStopped.mockImplementation((sessionId: string) => {
      queueStoppedCommandWake({
        backgroundCommandStore,
        deferredPromptStore,
        hasRunInFlight: (id) => manager.hasRunInFlight(id),
      }, sessionId);
    });
    const session = sessionWithCommand("s1", 0);
    await manager.cacheResumedSession("s1", session);
    await manager.agentRegistry.refresh("s1", "started");
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    // Settings changed: every idle session is reloaded, and reloading stops its commands.
    await manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(1);

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    const [delivery] = deferredPromptStore.listDeliveriesForSession("s1");
    expect(delivery?.status).toBe("pending");
    expect(delivery?.prompt).toContain('shellId 7 "Test refresh"');
    expect(delivery?.prompt).toContain("Continue the work that was waiting on these commands.");
    // The wake carries the notice, so the next message does not repeat it.
    expect(manager.prepareTurnContext("s1").block).toBeUndefined();
  });

  it("wakes the agent when its session is reloaded under a command it was waiting for", async () => {
    const { manager, backgroundCommandStore, deferredPromptStore, onBackgroundCommandsStopped } = createManager();
    const seen: Array<{ busy: boolean; runInFlight: boolean; outcome: string }> = [];
    onBackgroundCommandsStopped.mockImplementation((sessionId: string) => {
      seen.push({
        busy: manager.isSessionBusy(sessionId),
        runInFlight: manager.hasRunInFlight(sessionId),
        outcome: queueStoppedCommandWake({
          backgroundCommandStore,
          deferredPromptStore,
          hasRunInFlight: (id) => manager.hasRunInFlight(id),
        }, sessionId),
      });
    });
    const session = sessionWithCommand("s1", 0);
    await manager.cacheResumedSession("s1", session);
    await manager.agentRegistry.refresh("s1", "started");
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    // The reload has released the old handle and is still waiting for the new one.
    let finishResume!: (session: ReturnType<typeof makeAgentSessionStub>) => void;
    manager.backend = {
      resumeSession: vi.fn(() => new Promise((resolve) => { finishResume = resolve; })),
    };
    const reloading = manager.reloadSession("s1");
    await vi.advanceTimersByTimeAsync(1);

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    // Loading the session again makes it busy, but no run is coming whose prompt could carry the notice.
    expect(seen).toEqual([{ busy: true, runInFlight: false, outcome: "queued" }]);
    const [delivery] = deferredPromptStore.listDeliveriesForSession("s1");
    expect(delivery?.status).toBe("pending");
    expect(delivery?.prompt).toContain('shellId 7 "Test refresh"');

    finishResume(makeAgentSessionStub({ sessionId: "s1" }));
    await vi.advanceTimersByTimeAsync(1);
    await reloading;
    expect(manager.isSessionBusy("s1")).toBe(false);
  });

  it("stays silent for a session that is being deleted", async () => {
    const { manager, db, backgroundCommandStore, onBackgroundCommandsStopped } = createManager();
    const session = sessionWithCommand("s1", 0);
    await manager.cacheResumedSession("s1", session);
    await manager.agentRegistry.refresh("s1", "started");

    manager.deletingSessions.add("s1");
    await manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(1);

    expect(backgroundCommandStore.listStopped("s1")).toEqual([]);
    expect(onBackgroundCommandsStopped).not.toHaveBeenCalled();
    backgroundCommandStore.forgetSession("s1");
    expect(runningMarkers(db, "s1")).toBe(0);
  });

  it("leaves the markers running on shutdown, for the next boot to report", async () => {
    const { manager, db, backgroundCommandStore, onBackgroundCommandsStopped } = createManager();
    const session = sessionWithCommand("s1", 0);
    await manager.cacheResumedSession("s1", session);
    await manager.agentRegistry.refresh("s1", "started");

    manager.stopAdmittingWork();
    await manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(1);

    expect(runningMarkers(db, "s1")).toBe(1);
    expect(backgroundCommandStore.listStopped("s1")).toEqual([]);
    expect(onBackgroundCommandsStopped).not.toHaveBeenCalled();
    expect(backgroundCommandStore.markAllRunningStopped("restart")).toHaveLength(1);
  });
});
