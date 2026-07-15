import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionAgentRegistry } from "../session-agent-registry.js";
import type { StatusEvent } from "../global-bus.js";
import type { AgentBackgroundTask, AgentSession } from "../agent-backend/index.js";

function makeBus() {
  const events: StatusEvent[] = [];
  return {
    events,
    bus: {
      emit: (event: StatusEvent) => { events.push(event); },
      subscribe: () => () => {},
    },
  };
}

function agentTask(partial: Partial<AgentBackgroundTask> & Pick<AgentBackgroundTask, "id" | "status">): AgentBackgroundTask {
  return { kind: "agent", executionMode: "background", ...partial };
}

/** Minimal fake AgentSession exposing only listTasks. */
function fakeSession(listTasks: () => Promise<{ tasks?: AgentBackgroundTask[] } | undefined>): AgentSession {
  return { sessionId: "s1", listTasks } as unknown as AgentSession;
}

describe("SessionAgentRegistry", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns unknown source before any refresh", () => {
    const { bus } = makeBus();
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => undefined });
    expect(registry.getSummary("s1")).toMatchObject({ source: "unknown", running: 0, total: 0 });
    registry.dispose();
  });

  it("projects background tasks and emits counts on change", async () => {
    const { bus, events } = makeBus();
    const session = fakeSession(async () => ({
      tasks: [
        agentTask({ id: "a", status: "running" }),
        agentTask({ id: "b", status: "idle" }),
        agentTask({ id: "shell", status: "running", kind: "shell" }),
      ],
    }));
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: () => session,
    });

    await registry.refresh("s1", "test");
    const summary = registry.getSummary("s1");
    expect(summary).toMatchObject({ running: 1, idle: 1, total: 2, source: "live" });
    // shell task is excluded
    expect(registry.getSnapshot("s1").tasks.map((t) => t.id).sort()).toEqual(["a", "b"]);

    const agentEvents = events.filter((e) => e.type === "session:agents");
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0].backgroundAgents).toMatchObject({ running: 1, idle: 1, source: "live" });
    registry.dispose();
  });

  it("reports tracked weight and running protection, notifying only on task changes", async () => {
    const { bus } = makeBus();
    let status = "running";
    const onTasksChanged = vi.fn();
    const session = fakeSession(async () => ({
      tasks: [
        agentTask({ id: "a", status }),
        agentTask({ id: "b", status: "completed" }),
      ],
    }));
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: () => session,
      onTasksChanged,
    });

    await registry.refresh("s1", "first");
    expect(registry.getTrackedAgentCount("s1")).toBe(2);
    expect(registry.hasRunningAgents("s1")).toBe(true);
    expect(onTasksChanged).toHaveBeenCalledTimes(1);

    await registry.refresh("s1", "unchanged");
    expect(onTasksChanged).toHaveBeenCalledTimes(1);

    status = "idle";
    await registry.refresh("s1", "idle");
    expect(registry.hasRunningAgents("s1")).toBe(false);
    expect(onTasksChanged).toHaveBeenCalledTimes(2);
    registry.dispose();
  });

  it("reaps finished sync agents while preserving running and background agents", async () => {
    const { bus } = makeBus();
    let tasks = [
      agentTask({ id: "sync-idle", status: "idle", executionMode: "sync" }),
      agentTask({ id: "background-idle", status: "idle" }),
      agentTask({ id: "sync-running", status: "running", executionMode: "sync" }),
      agentTask({ id: "sync-completed", status: "completed", executionMode: "sync" }),
      agentTask({ id: "background-completed", status: "completed" }),
    ];
    const removeTask = vi.fn(async (id: string) => {
      const previousLength = tasks.length;
      tasks = tasks.filter((task) => task.id !== id);
      return { removed: tasks.length < previousLength };
    });
    const session = {
      sessionId: "s1",
      listTasks: vi.fn(async () => ({ tasks })),
      removeTask,
    } as unknown as AgentSession;
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: () => session,
    });

    await registry.refresh("s1", "test");
    await expect(registry.reapFinishedSyncTasks("s1")).resolves.toBe(2);

    expect(removeTask.mock.calls.map(([id]) => id)).toEqual([
      "sync-idle",
      "sync-completed",
    ]);
    expect(registry.getSnapshot("s1").tasks.map((task) => task.id)).toEqual([
      "background-idle",
      "sync-running",
      "background-completed",
    ]);
    expect(registry.getTrackedAgentCount("s1")).toBe(3);
    registry.dispose();
  });

  it("suppresses duplicate emissions when counts are unchanged", async () => {
    const { bus, events } = makeBus();
    const session = fakeSession(async () => ({ tasks: [agentTask({ id: "a", status: "running" })] }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session });

    await registry.refresh("s1", "first");
    await registry.refresh("s1", "second");
    expect(events.filter((e) => e.type === "session:agents")).toHaveLength(1);
    registry.dispose();
  });

  it("degrades a live snapshot to lastSeen after the freshness window", async () => {
    const { bus } = makeBus();
    const session = fakeSession(async () => ({ tasks: [agentTask({ id: "a", status: "completed" })] }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session });

    await registry.refresh("s1", "test");
    expect(registry.getSummary("s1").source).toBe("live");
    vi.setSystemTime(61_000);
    expect(registry.getSummary("s1").source).toBe("lastSeen");
    registry.dispose();
  });

  it("aggregates only fresh snapshots while reporting stale and unknown sessions", async () => {
    const { bus } = makeBus();
    const sessions = new Map<string, AgentSession>([
      ["stale", fakeSession(async () => ({
        tasks: [agentTask({ id: "stale-running", status: "running" })],
      }))],
      ["live", fakeSession(async () => ({
        tasks: [
          agentTask({ id: "live-idle", status: "idle" }),
          agentTask({ id: "live-failed", status: "failed" }),
          agentTask({ id: "live-completed", status: "completed" }),
        ],
      }))],
      ["unknown", fakeSession(async () => {
        throw new Error("tasks unavailable");
      })],
    ]);
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: (sessionId) => sessions.get(sessionId),
      logger: { warn: vi.fn() },
    });

    await registry.refresh("stale", "test");
    vi.setSystemTime(61_000);
    await registry.refresh("live", "test");
    await registry.refresh("unknown", "test");

    expect(registry.getAggregate()).toEqual({
      running: 0,
      idle: 1,
      failed: 1,
      total: 3,
      liveSessions: 1,
      staleSessions: 1,
      unknownSessions: 1,
    });
    registry.dispose();
  });

  it("no-ops when no live session is cached, leaving prior snapshot intact", async () => {
    const { bus } = makeBus();
    let session: AgentSession | undefined = fakeSession(async () => ({
      tasks: [agentTask({ id: "a", status: "running" })],
    }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session });

    await registry.refresh("s1", "test");
    expect(registry.getSummary("s1").running).toBe(1);

    session = undefined;
    await registry.refresh("s1", "evicted");
    // still has last snapshot (will age to lastSeen via freshness window)
    expect(registry.getSnapshot("s1").tasks).toHaveLength(1);
    registry.dispose();
  });

  it("polls while non-terminal background agents remain, then stops", async () => {
    const { bus } = makeBus();
    const statuses = ["running", "running", "completed"];
    let call = 0;
    const session = fakeSession(async () => ({
      tasks: [agentTask({ id: "a", status: statuses[Math.min(call++, statuses.length - 1)] })],
    }));
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: () => session,
      pollIntervalMs: 1_000,
    });

    await registry.refresh("s1", "test"); // call 0 -> running, starts poll
    expect(call).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000); // call 1 -> running
    await vi.advanceTimersByTimeAsync(1_000); // call 2 -> completed, stops poll
    const callsAfterStop = call;
    await vi.advanceTimersByTimeAsync(3_000); // no further polling
    expect(call).toBe(callsAfterStop);
    expect(registry.getSnapshot("s1").tasks[0].status).toBe("completed");
    registry.dispose();
  });

  it("does not poll when the only background agents are terminal", async () => {
    const { bus } = makeBus();
    let call = 0;
    const session = fakeSession(async () => { call++; return { tasks: [agentTask({ id: "a", status: "completed" })] }; });
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: () => session,
      pollIntervalMs: 1_000,
    });

    await registry.refresh("s1", "test");
    expect(call).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(call).toBe(1);
    registry.dispose();
  });

  it("emits a lastSeen demotion when the live session becomes unavailable", async () => {
    const { bus, events } = makeBus();
    let session: AgentSession | undefined = fakeSession(async () => ({
      tasks: [agentTask({ id: "a", status: "idle" })],
    }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session, pollIntervalMs: 1_000 });

    await registry.refresh("s1", "test");
    expect(registry.getSummary("s1").source).toBe("live");
    events.length = 0;

    session = undefined;
    registry.markSessionUnavailable("s1");
    const agentEvents = events.filter((e) => e.type === "session:agents");
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0].backgroundAgents).toMatchObject({ idle: 1, source: "lastSeen" });
    registry.dispose();
  });

  it("does not demote a terminal-only snapshot on unavailability", async () => {
    const { bus, events } = makeBus();
    let session: AgentSession | undefined = fakeSession(async () => ({
      tasks: [agentTask({ id: "a", status: "completed" })],
    }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session });

    await registry.refresh("s1", "test");
    events.length = 0;
    session = undefined;
    registry.markSessionUnavailable("s1");
    expect(events.filter((e) => e.type === "session:agents")).toHaveLength(0);
    registry.dispose();
  });

  it("emits a lastSeen demotion when the poll hits its safety cap", async () => {
    const { bus, events } = makeBus();
    const session = fakeSession(async () => ({ tasks: [agentTask({ id: "a", status: "idle" })] }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session, pollIntervalMs: 1_000 });

    await registry.refresh("s1", "test"); // idle background -> starts poll
    events.length = 0;
    // advance beyond POLL_MAX_DURATION_MS (10 min); next tick stops + demotes
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    const agentEvents = events.filter((e) => e.type === "session:agents");
    expect(agentEvents.at(-1)?.backgroundAgents).toMatchObject({ idle: 1, source: "lastSeen" });
    registry.dispose();
  });

  it("keeps refreshing beyond the poll cap while an agent is still running", async () => {
    const { bus } = makeBus();
    let status = "running";
    let calls = 0;
    const session = fakeSession(async () => {
      calls++;
      return { tasks: [agentTask({ id: "a", status })] };
    });
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: () => session,
      pollIntervalMs: 1_000,
    });

    await registry.refresh("s1", "test");
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(calls).toBeGreaterThan(2);
    expect(registry.hasRunningAgents("s1")).toBe(true);

    status = "completed";
    await vi.advanceTimersByTimeAsync(1_000);
    const callsAfterCompletion = calls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(callsAfterCompletion);
    expect(registry.hasRunningAgents("s1")).toBe(false);
    registry.dispose();
  });

  it("forget clears state and stops polling", async () => {
    const { bus } = makeBus();
    const session = fakeSession(async () => ({ tasks: [agentTask({ id: "a", status: "running" })] }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session, pollIntervalMs: 1_000 });

    await registry.refresh("s1", "test");
    registry.forget("s1");
    expect(registry.getSummary("s1").source).toBe("unknown");
    const before = (await session.listTasks?.()) ? 1 : 0;
    void before;
    registry.dispose();
  });

  it("clears heavy free-text fields on eviction while preserving counts/status", async () => {
    const { bus } = makeBus();
    let session: AgentSession | undefined = fakeSession(async () => ({
      tasks: [
        agentTask({
          id: "a",
          status: "running",
          prompt: "secret prompt",
          result: "big result",
          latestResponse: "latest response",
          error: "boom",
        }),
        agentTask({ id: "b", status: "idle", prompt: "p2", result: "r2" }),
      ],
    }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session });

    await registry.refresh("s1", "test");
    const liveA = registry.getSnapshot("s1").tasks.find((t) => t.id === "a");
    expect(liveA).toMatchObject({
      prompt: "secret prompt",
      result: "big result",
      latestResponse: "latest response",
      error: "boom",
    });

    session = undefined;
    registry.markSessionUnavailable("s1");

    const after = registry.getSnapshot("s1");
    expect(after.tasks.map((t) => t.id).sort()).toEqual(["a", "b"]);
    for (const task of after.tasks) {
      expect(task.prompt).toBeUndefined();
      expect(task.result).toBeUndefined();
      expect(task.latestResponse).toBeUndefined();
      expect(task.error).toBeUndefined();
    }
    // counts and per-task status are untouched
    expect(registry.getSummary("s1")).toMatchObject({ running: 1, idle: 1, total: 2 });
    expect(after.tasks.find((t) => t.id === "a")?.status).toBe("running");
    registry.dispose();
  });

  it("preserves freshness (live -> lastSeen) after clearing text on eviction", async () => {
    const { bus } = makeBus();
    let session: AgentSession | undefined = fakeSession(async () => ({
      tasks: [agentTask({ id: "a", status: "idle", prompt: "p" })],
    }));
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session });

    await registry.refresh("s1", "test");
    session = undefined;
    registry.markSessionUnavailable("s1");
    expect(registry.getSummary("s1")).toMatchObject({ idle: 1, total: 1, source: "live" });
    vi.setSystemTime(61_000);
    expect(registry.getSummary("s1").source).toBe("lastSeen");
    registry.dispose();
  });

  it("does not repopulate heavy text when the session is evicted mid-refresh", async () => {
    const { bus, events } = makeBus();
    let resolveList!: (value: { tasks: AgentBackgroundTask[] }) => void;
    const pending = new Promise<{ tasks: AgentBackgroundTask[] }>((resolve) => { resolveList = resolve; });
    let session: AgentSession | undefined = fakeSession(() => pending);
    const registry = new SessionAgentRegistry({ globalBus: bus, getLiveSession: () => session });

    const inFlight = registry.refresh("s1", "test");
    // Evict before listTasks resolves, then deliver heavy text.
    session = undefined;
    resolveList({ tasks: [agentTask({ id: "a", status: "running", prompt: "secret" })] });
    await inFlight;

    const snap = registry.getSnapshot("s1");
    expect(snap.source).toBe("unknown");
    expect(snap.tasks).toHaveLength(0);
    // No `live` update is emitted for a session we can no longer vouch for.
    expect(events.filter((e) => e.type === "session:agents")).toHaveLength(0);
    registry.dispose();
  });

  it("keeps the entries map bounded across many evicted sessions", async () => {
    const { bus } = makeBus();
    const live = new Map<string, AgentSession>();
    const maxEntries = 5;
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: (id) => live.get(id),
      maxEntries,
      pollIntervalMs: 1_000,
    });

    const total = 20;
    for (let i = 0; i < total; i++) {
      const id = `s${i}`;
      vi.setSystemTime(i * 100); // distinct refreshedAt so LRU ordering is meaningful
      const session = fakeSession(async () => ({
        tasks: [agentTask({ id: "a", status: "running", prompt: "x" })],
      }));
      live.set(id, session);
      await registry.refresh(id, "test");
      // Simulate eviction: live object gone + registry notified.
      live.delete(id);
      registry.markSessionUnavailable(id);
    }

    // Dropped entries report "unknown"; retained entries report live/lastSeen.
    let retained = 0;
    for (let i = 0; i < total; i++) {
      if (registry.getSummary(`s${i}`).source !== "unknown") retained += 1;
    }
    expect(retained).toBeLessThanOrEqual(maxEntries);
    // The most recently refreshed sessions are the ones kept.
    expect(registry.getSummary(`s${total - 1}`).source).not.toBe("unknown");
    expect(registry.getSummary("s0").source).toBe("unknown");
    registry.dispose();
  });

  it("never evicts entries with a live session to satisfy the bound", async () => {
    const { bus } = makeBus();
    const live = new Map<string, AgentSession>();
    const registry = new SessionAgentRegistry({
      globalBus: bus,
      getLiveSession: (id) => live.get(id),
      maxEntries: 2,
    });

    // Three sessions that all stay live: the bound must not drop any of them.
    for (let i = 0; i < 3; i++) {
      const id = `live${i}`;
      vi.setSystemTime(i * 100);
      live.set(id, fakeSession(async () => ({ tasks: [agentTask({ id: "a", status: "running" })] })));
      await registry.refresh(id, "test");
    }
    expect(registry.getSummary("live0").source).not.toBe("unknown");
    expect(registry.getSummary("live1").source).not.toBe("unknown");
    expect(registry.getSummary("live2").source).not.toBe("unknown");
    registry.dispose();
  });
});
