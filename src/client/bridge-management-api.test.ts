import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  fetchBridgeRuntimeStatus,
  restartBridge,
  type BridgeRuntimeStatus,
} from "./bridge-management-api";

function stubJsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bridge management client API", () => {
  it("fetches runtime status and queues restart requests", async () => {
    const runtime: BridgeRuntimeStatus = {
      fetchedAt: "2026-07-15T12:00:00.000Z",
      serverInstanceId: "server-1",
      pid: 1234,
      uptimeSeconds: 90,
      isStaging: false,
      sourceManagementAvailable: true,
      sessions: { active: 2, stalled: 1, waitingForUserInput: 1 },
      agents: {
        running: 3,
        idle: 1,
        failed: 0,
        total: 5,
        liveSessions: 2,
        staleSessions: 0,
        unknownSessions: 0,
      },
      capacity: {
        contexts: { used: 8, retained: 10, limit: 32 },
        weightedUnits: { used: 12.5, retained: 15, limit: 64 },
        localMcpSlots: { used: 18, retained: 20 },
        cache: { readyParents: 7, protectedParents: 2, limit: 16 },
        cleanup: { pending: 0, failed: 0, limit: 32 },
        processes: {
          actualDescendants: 24,
          projectedReservations: 2,
          used: 26,
          limit: 96,
          sampleStatus: "sampled",
          sampledAt: "2026-07-15T12:00:00.000Z",
        },
        waitingRequests: 0,
        localMcpWeight: 0.25,
        waitTimeoutSeconds: 30,
      },
    };
    stubJsonResponse(runtime);

    await expect(fetchBridgeRuntimeStatus()).resolves.toEqual(runtime);
    expect(fetch).toHaveBeenLastCalledWith("/api/server/runtime-status", { signal: undefined });

    stubJsonResponse({ ok: true, waitingSessions: 2 }, { status: 202 });
    await expect(restartBridge()).resolves.toEqual({ ok: true, waitingSessions: 2 });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/server/restart",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
  });

  it("surfaces restart errors as ApiError", async () => {
    stubJsonResponse(
      { error: "A restart is already pending.", details: { phase: "queued" } },
      { ok: false, status: 409, statusText: "Conflict" },
    );

    await expect(restartBridge()).rejects.toMatchObject({
      name: "ApiError",
      message: "A restart is already pending.",
      status: 409,
      details: { phase: "queued" },
    });
    await expect(restartBridge()).rejects.toBeInstanceOf(ApiError);
  });
});
