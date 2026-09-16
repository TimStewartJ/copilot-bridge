import { describe, expect, it } from "vitest";
import {
  createBlockedBackendRecoveryMonitor,
  evaluateHealthPoll,
  evaluatePostRecoveryState,
  evaluateUnexpectedExit,
  readRecoveryBlockedAt,
  shouldIgnoreHealthPollResult,
} from "./launcher-health.js";

describe("evaluateHealthPoll", () => {
  it("records a single failed health poll without triggering recovery", () => {
    expect(
      evaluateHealthPoll({
        healthy: false,
        hasServerProcess: true,
        consecutiveFailures: 0,
        failureThreshold: 3,
        failureDetail: "timed out after 5000ms",
      }),
    ).toEqual({
      nextFailures: 1,
      logMessage: "Health check failed (1/3): timed out after 5000ms",
    });
  });

  it("triggers recovery after three consecutive failed health polls", () => {
    expect(
      evaluateHealthPoll({
        healthy: false,
        hasServerProcess: true,
        consecutiveFailures: 2,
        failureThreshold: 3,
      }),
    ).toEqual({
      nextFailures: 3,
      logMessage: "Health check failed (3/3)",
      recover: {
        reason: "3 consecutive health check failures",
        killExisting: true,
      },
    });
  });

  it("resets the failure counter after a successful health poll", () => {
    expect(
      evaluateHealthPoll({
        healthy: true,
        hasServerProcess: true,
        consecutiveFailures: 1,
        failureThreshold: 2,
      }),
    ).toEqual({
      nextFailures: 0,
    });
  });

  it("restarts a missing child without trying to kill an already-missing process", () => {
    expect(
      evaluateHealthPoll({
        healthy: false,
        hasServerProcess: false,
        consecutiveFailures: 0,
        failureThreshold: 2,
      }),
    ).toEqual({
      nextFailures: 0,
      logMessage: "Server process missing (restarting immediately)",
      recover: {
        reason: "missing server process",
        killExisting: false,
      },
    });
  });
});

describe("shouldIgnoreHealthPollResult", () => {
  it("ignores stale poll results after the polled child changes and applies results for the same child", () => {
    expect(
      shouldIgnoreHealthPollResult({
        pollTargetChanged: true,
        restarting: false,
        shuttingDown: false,
        recoveringServer: false,
      }),
      "target changed",
    ).toBe(true);
    expect(
      shouldIgnoreHealthPollResult({
        pollTargetChanged: false,
        restarting: false,
        shuttingDown: false,
        recoveringServer: false,
      }),
      "same target",
    ).toBe(false);
  });
});

describe("evaluateUnexpectedExit", () => {
  it("delays restart for a non-zero crash exit", () => {
    expect(
      evaluateUnexpectedExit({
        code: 1,
        signal: null,
        restarting: false,
        shuttingDown: false,
        recoveringServer: false,
        crashRestartDelay: 5000,
      }),
    ).toEqual({
      reason: "crash (exit code 1)",
      options: { delayMs: 5000 },
    });
  });

  it("immediately recovers an unexpected missing child", () => {
    expect(
      evaluateUnexpectedExit({
        code: 0,
        signal: null,
        restarting: false,
        shuttingDown: false,
        recoveringServer: false,
        crashRestartDelay: 5000,
      }),
    ).toEqual({
      reason: "missing server process",
      options: { killExisting: false },
    });
  });
});

describe("evaluatePostRecoveryState", () => {
  it("requests immediate recovery when a suppression window ends without a child", () => {
    expect(
      evaluatePostRecoveryState({
        hasServerProcess: false,
        restarting: false,
        recoveringServer: false,
        shuttingDown: false,
      }),
    ).toEqual({
      reason: "missing server process",
      options: { killExisting: false },
    });
  });

  it("does nothing when a child is still present", () => {
    expect(
      evaluatePostRecoveryState({
        hasServerProcess: true,
        restarting: false,
        recoveringServer: false,
        shuttingDown: false,
      }),
    ).toBeNull();
  });
});

describe("readRecoveryBlockedAt", () => {
  it("reads a valid blocked timestamp and ignores anything else", () => {
    expect(readRecoveryBlockedAt({ ok: true, agentBackend: { recoveryBlockedAt: "2026-09-16T16:54:46.224Z" } }))
      .toBe("2026-09-16T16:54:46.224Z");
    expect(readRecoveryBlockedAt({ ok: true, agentBackend: { recoveryBlockedAt: null } })).toBeNull();
    expect(readRecoveryBlockedAt({ ok: true, agentBackend: { recoveryBlockedAt: "not a date" } })).toBeNull();
    expect(readRecoveryBlockedAt({ ok: true })).toBeNull();
    expect(readRecoveryBlockedAt(null)).toBeNull();
    expect(readRecoveryBlockedAt("ok")).toBeNull();
  });
});

describe("createBlockedBackendRecoveryMonitor", () => {
  const startMs = Date.parse("2026-09-16T17:00:00.000Z");
  const minuteMs = 60_000;

  function createMonitor(options: { suppressed?: boolean } = {}) {
    const logs: string[] = [];
    const notifications: string[] = [];
    const restarts: string[] = [];
    let suppressed = options.suppressed ?? false;
    const monitor = createBlockedBackendRecoveryMonitor({
      graceMs: minuteMs,
      maxRestarts: 3,
      windowMs: 60 * minuteMs,
      log: (message) => logs.push(message),
      notify: (message) => notifications.push(message),
      restart: (reason) => restarts.push(reason),
      isAutoRecoverySuppressed: () => suppressed,
    });
    return { monitor, logs, notifications, restarts, setSuppressed: (value: boolean) => { suppressed = value; } };
  }

  const blockedAt = (atMs: number) => new Date(atMs).toISOString();

  it("does nothing while recovery is not blocked or still inside the grace period", () => {
    const { monitor, logs, notifications, restarts } = createMonitor();
    expect(monitor.observe(null, startMs)).toBe("not-blocked");
    expect(monitor.observe(blockedAt(startMs), startMs + minuteMs - 1)).toBe("waiting");
    expect(logs).toEqual([]);
    expect(notifications).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("restarts once the block has persisted past the grace period and counts the restart", () => {
    const { monitor, logs, restarts } = createMonitor();
    expect(monitor.observe(blockedAt(startMs), startMs + 75_000)).toBe("restarting");
    expect(restarts).toEqual(["agent backend recovery blocked for 75s"]);
    expect(logs).toEqual([
      "Agent backend recovery has been blocked for 75s; restarting the server (automatic restart 1/3 this window)",
    ]);
  });

  it("stops after the window budget is spent, reports once, and recovers the budget as restarts age out", () => {
    const { monitor, logs, notifications, restarts } = createMonitor();
    for (const minute of [1, 30, 45]) {
      expect(monitor.observe(blockedAt(startMs), startMs + minute * minuteMs)).toBe("restarting");
    }
    expect(monitor.observe(blockedAt(startMs), startMs + 50 * minuteMs)).toBe("budget-exhausted");
    expect(monitor.observe(blockedAt(startMs), startMs + 55 * minuteMs)).toBe("budget-exhausted");
    expect(restarts).toHaveLength(3);
    expect(logs.filter((message) => message.includes("Manual intervention needed"))).toHaveLength(1);
    expect(notifications).toEqual([
      "❌ Copilot Bridge agent backend recovery is blocked and 3 automatic restart(s) already ran in the last 60 minutes. Manual intervention needed.",
    ]);

    // The first restart ages out of the one-hour window, so one more restart is allowed.
    expect(monitor.observe(blockedAt(startMs), startMs + 62 * minuteMs)).toBe("restarting");
    expect(restarts).toHaveLength(4);
    expect(logs.at(-1)).toContain("(automatic restart 3/3 this window)");
  });

  it("never restarts or spends budget while automatic recovery is suppressed, and reports it once per episode", () => {
    const { monitor, logs, notifications, restarts, setSuppressed } = createMonitor({ suppressed: true });
    expect(monitor.observe(blockedAt(startMs), startMs + 2 * minuteMs)).toBe("suppressed");
    expect(monitor.observe(blockedAt(startMs), startMs + 3 * minuteMs)).toBe("suppressed");
    expect(restarts).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("automatic recovery is suppressed");
    expect(notifications).toEqual([
      "❌ Copilot Bridge agent backend recovery is blocked and automatic recovery is suppressed. Manual intervention needed.",
    ]);

    // Once suppression lifts, the full restart budget is still available.
    setSuppressed(false);
    for (const minute of [4, 5, 6]) {
      expect(monitor.observe(blockedAt(startMs), startMs + minute * minuteMs)).toBe("restarting");
    }
    expect(restarts).toHaveLength(3);
  });

  it("reports a new episode again after recovery stops being blocked", () => {
    const { monitor, notifications } = createMonitor({ suppressed: true });
    expect(monitor.observe(blockedAt(startMs), startMs + 2 * minuteMs)).toBe("suppressed");
    expect(monitor.observe(null, startMs + 3 * minuteMs)).toBe("not-blocked");
    expect(monitor.observe(blockedAt(startMs + 4 * minuteMs), startMs + 6 * minuteMs)).toBe("suppressed");
    expect(notifications).toHaveLength(2);
  });
});
