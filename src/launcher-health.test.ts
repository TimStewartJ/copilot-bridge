import { describe, expect, it } from "vitest";
import {
  evaluateHealthPoll,
  evaluatePostRecoveryState,
  evaluateUnexpectedExit,
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
  it("ignores stale poll results after the polled child changes", () => {
    expect(
      shouldIgnoreHealthPollResult({
        pollTargetChanged: true,
        restarting: false,
        shuttingDown: false,
        recoveringServer: false,
      }),
    ).toBe(true);
  });

  it("applies poll results when the same child is still active", () => {
    expect(
      shouldIgnoreHealthPollResult({
        pollTargetChanged: false,
        restarting: false,
        shuttingDown: false,
        recoveringServer: false,
      }),
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
