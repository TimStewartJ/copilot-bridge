import { describe, expect, it, vi } from "vitest";
import { waitForIdleSessions, type BusyState } from "../restart-coordinator.js";

function createDeps(states: Array<BusyState | Error>, opts?: { isServerAlive?: () => boolean }) {
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
      busyWaitTimeout: 10,
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
    ]);

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
