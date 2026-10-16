import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../agent-backend/index.js";
import {
  SessionCapacityController,
  SessionCapacityError,
  type SessionCleanupCapacity,
} from "../session-capacity.js";
import { makeAgentSessionStub } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const sessions = new Map<string, AgentSession>();
  const cleanup: SessionCleanupCapacity[] = [];
  const agents = new Map<string, number>();
  const protectedIds = new Set<string>();
  const limits = { parents: 16, contexts: 32, cleanup: 32, units: 64, localMcpWeight: 0.25, waitTimeoutMs: 0 };
  const recordSpan = vi.fn();
  const reap = vi.fn(async () => 0);
  const capacity = new SessionCapacityController({
    getLimits: () => limits,
    getSessions: () => sessions,
    getCleanupRecords: () => cleanup,
    getProtectedSessionIds: () => protectedIds,
    getTrackedAgentCount: (id) => agents.get(id) ?? 0,
    reapFinishedSyncTasks: reap,
    recordSpan,
  });
  return { capacity, sessions, cleanup, agents, protectedIds, limits, recordSpan, reap };
}

describe("SessionCapacityController", () => {
  it("tracks weighted session trees and transfers profiles without exposing the accounting maps", () => {
    const { capacity, sessions, agents } = fixture();
    const first = makeAgentSessionStub({ sessionId: "one" });
    sessions.set("one", first);
    agents.set("one", 2);
    capacity.trackSession(first, { mcpServers: {
      local: { command: "local", args: [] },
      remote: { type: "http", url: "https://example.test/mcp" },
    } });
    expect(capacity.getTreeCapacity("one")).toEqual({ localMcpInstances: 3, capacityUnits: 3.75 });
    expect(capacity.getCacheState()).toMatchObject({
      readyParents: 1, trackedAgents: 2, readyContextWeight: 3,
      readyLocalMcpInstances: 3, readyCapacityUnits: 3.75,
    });
    const next = makeAgentSessionStub({ sessionId: "one" });
    capacity.trackSession(next, undefined, first);
    sessions.set("one", next);
    capacity.forgetSession(first);
    expect(capacity.getTreeCapacity("one")).toEqual({ localMcpInstances: 3, capacityUnits: 3.75 });
  });

  it("reserves concurrent creations atomically and releases their exact weight", async () => {
    const { capacity, limits } = fixture();
    limits.contexts = 1;
    const [reservation] = await Promise.all([
      capacity.beginCreation({ mcpServers: { local: { command: "local", args: [] } } }),
      expect(capacity.beginCreation({})).rejects.toMatchObject({ reason: "context-limit" }),
    ]);
    expect(capacity.getCacheState()).toMatchObject({
      reservedContexts: 1, reservedLocalMcpInstances: 1, reservedCapacityUnits: 1.25,
    });
    capacity.endCreation(reservation);
    expect(capacity.getCacheState()).toMatchObject({
      reservedContexts: 0, reservedLocalMcpInstances: 0, reservedCapacityUnits: 0,
    });
  });

  it("accounts for cleanup leases until their runtime owner releases them", () => {
    const { capacity, cleanup } = fixture();
    cleanup.push({ phase: "quarantined", contextWeight: 3, localMcpInstances: 6, capacityUnits: 4.5 });
    expect(capacity.getCacheState()).toMatchObject({
      retainedParents: 1, retainedContextWeight: 3, retainedLocalMcpInstances: 6,
      retainedCapacityUnits: 4.5, failedCleanup: 1,
    });
    expect(() => capacity.assertAvailable({ localMcpInstances: 0, capacityUnits: 1 }))
      .toThrow(SessionCapacityError);
    expect(() => capacity.assertAvailable({ localMcpInstances: 0, capacityUnits: 1 }))
      .toThrow(expect.objectContaining({
        reason: "cleanup-failed",
        snapshot: { contexts: 3, contextLimit: 32, localMcpInstances: 6, capacityUnits: 4.5, capacityLimit: 64 },
      }));
  });

  it("wakes admission waiters only after the caller announces a resource change", async () => {
    const { capacity, cleanup, limits, recordSpan } = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    limits.waitTimeoutMs = 5_000;
    cleanup.push({ phase: "quarantined", contextWeight: 1, localMcpInstances: 0, capacityUnits: 1 });
    const token = Symbol("resume");
    const pending = capacity.admit({}, { reserve: (reservation) => capacity.reserveResume(token, reservation) });
    expect(capacity.getCacheState().waitingForCapacity).toBe(1);
    cleanup.length = 0;
    capacity.notifyChanged();
    await expect(pending).resolves.toEqual({ localMcpInstances: 0, capacityUnits: 1 });
    expect(capacity.getCacheState()).toMatchObject({ waitingForCapacity: 0, reservedContexts: 1 });
    expect(recordSpan).toHaveBeenCalledWith("session.capacity.wait", expect.any(Number),
      expect.objectContaining({ outcome: "admitted", reason: "cleanup-failed" }));
    capacity.releaseResume(token);
    expect(capacity.getCacheState().reservedContexts).toBe(0);
  });

  it("does not reserve a cancelled admission", async () => {
    const { capacity } = fixture();
    const reserve = vi.fn();
    await expect(capacity.admit({}, { isCancelled: () => true, reserve })).resolves.toBeNull();
    expect(reserve).not.toHaveBeenCalled();
    expect(capacity.getCacheState().reservedContexts).toBe(0);
  });
});
