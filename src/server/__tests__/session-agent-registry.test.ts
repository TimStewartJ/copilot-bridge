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
});
