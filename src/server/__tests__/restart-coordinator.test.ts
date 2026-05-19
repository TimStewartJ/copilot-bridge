import { describe, expect, it, vi } from "vitest";
import { fetchRestartBusyState, waitForIdleSessions, type BusyState } from "../restart-coordinator.js";

function createDeps(
  states: Array<BusyState | Error>,
  opts?: { isServerAlive?: () => boolean; busyWaitTimeout?: number },
) {
  const log = vi.fn();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const fetchBusy = vi.fn(async () => {
    const next = states.shift();
    if (!next) return { busy: false, count: 0, sessions: [] };
    if (next instanceof Error) throw next;
    return next;
  });

  return {
    deps: {
      fetchBusy,
      sleep,
      log,
      isServerAlive: opts?.isServerAlive ?? (() => true),
      busyCheckInterval: 1,
      busyWaitTimeout: opts?.busyWaitTimeout ?? 10,
      staleThreshold: 5_000,
    },
    fetchBusy,
    sleep,
    log,
  };
}

describe("waitForIdleSessions", () => {
  it("returns immediately when no sessions are busy", async () => {
    const { deps, sleep, fetchBusy } = createDeps([{ busy: false, count: 0, sessions: [] }]);

    await expect(waitForIdleSessions(deps)).resolves.toBe(true);
    expect(fetchBusy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient busy-check failures while the server is still alive", async () => {
    const { deps, fetchBusy, log } = createDeps([
      new Error("ECONNRESET"),
      { busy: false, count: 0, sessions: [] },
    ], { busyWaitTimeout: 1_000 });

    await expect(waitForIdleSessions(deps)).resolves.toBe(true);
    expect(fetchBusy).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("Busy check failed while server is still running — retrying...");
  });

  it("proceeds on busy-check failure only after the server is gone", async () => {
    const { deps, log } = createDeps([new Error("ECONNREFUSED")], {
      isServerAlive: () => false,
    });

    await expect(waitForIdleSessions(deps)).resolves.toBe(true);
    expect(log).toHaveBeenCalledWith("Server not reachable for busy check — proceeding with restart");
  });

  it("proceeds when every active session is stale", async () => {
    const { deps, log } = createDeps([
      {
        busy: true,
        count: 2,
        sessions: [
          { id: "session-a", staleMs: 5_000, elapsedMs: 10 },
          { id: "session-b", staleMs: 8_000, elapsedMs: 12 },
        ],
      },
    ]);

    await expect(waitForIdleSessions(deps)).resolves.toBe(true);
    expect(log).toHaveBeenCalledWith("All 2 session(s) are stuck (no events for 5s+) — proceeding with restart");
  });
});

describe("fetchRestartBusyState", () => {
  function response(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  it("uses the restart-blocking busy endpoint after triggering quiesce", async () => {
    const log = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, {
        busy: true,
        count: 1,
        suspendedSessionIds: ["abcdef12-3456-7890-abcd-ef1234567890"],
        sessions: [{ id: "session-b", staleMs: 0, elapsedMs: 10 }],
      }))
      .mockResolvedValueOnce(response(200, {
        busy: false,
        count: 0,
        sessions: [],
      }));

    await expect(fetchRestartBusyState({
      fetch,
      quiesceUrl: "http://bridge/api/restart/quiesce",
      busyUrl: "http://bridge/api/busy?ignoreRestartPreservable=1",
      log,
    })).resolves.toEqual({
      busy: false,
      count: 0,
      sessions: [],
    });

    expect(fetch).toHaveBeenNthCalledWith(1, "http://bridge/api/restart/quiesce", { method: "POST" });
    expect(fetch).toHaveBeenNthCalledWith(2, "http://bridge/api/busy?ignoreRestartPreservable=1");
    expect(log).toHaveBeenCalledWith("Suspended 1 session(s) for restart: abcdef12");
  });

  it("falls back to the busy endpoint when quiesce is unavailable", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(404, { error: "Not found" }))
      .mockResolvedValueOnce(response(200, {
        busy: true,
        count: 1,
        sessions: [{ id: "session-a", staleMs: 0, elapsedMs: 10 }],
      }));

    await expect(fetchRestartBusyState({
      fetch,
      quiesceUrl: "http://bridge/api/restart/quiesce",
      busyUrl: "http://bridge/api/busy?ignoreRestartPreservable=1",
      log: vi.fn(),
    })).resolves.toEqual({
      busy: true,
      count: 1,
      sessions: [{ id: "session-a", staleMs: 0, elapsedMs: 10 }],
    });
  });
});
