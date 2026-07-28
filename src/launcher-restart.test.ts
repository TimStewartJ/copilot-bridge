import { describe, expect, it, vi } from "vitest";
import {
  didRestartRecover,
  resolveReleaseCandidateRestartOutcome,
  resolveRollbackRecoveryOutcome,
  rollbackRecoveryRequiresServerStart,
  startAfterVerifiedStop,
  shouldPersistReleaseFailureState,
} from "./launcher-restart.js";

describe("rollbackRecoveryRequiresServerStart", () => {
  it("restarts only when recovery began from a stopped state", () => {
    expect(rollbackRecoveryRequiresServerStart({ hadRunningServerAtStart: true }), "was running").toBe(false);
    expect(rollbackRecoveryRequiresServerStart({ hadRunningServerAtStart: false }), "was stopped").toBe(true);
  });
});

describe("resolveRollbackRecoveryOutcome", () => {
  it("maps rollback outcome and health to the correct recovery result", () => {
    // Server stayed running: rollback alone means recovered
    expect(
      resolveRollbackRecoveryOutcome({ rollbackSucceeded: true, hadRunningServerAtStart: true }),
      "running at start, healthy",
    ).toBe("recovered-via-rollback");
    // Stopped at start: need the rolled-back server to come up healthy
    expect(
      resolveRollbackRecoveryOutcome({ rollbackSucceeded: true, hadRunningServerAtStart: false, rolledBackServerHealthy: true }),
      "stopped at start, now healthy",
    ).toBe("recovered-via-rollback");
    expect(
      resolveRollbackRecoveryOutcome({ rollbackSucceeded: true, hadRunningServerAtStart: false, rolledBackServerHealthy: false }),
      "stopped at start, never healthy",
    ).toBe("failed");
  });
});

describe("didRestartRecover", () => {
  it("recognizes each outcome's recovery status", () => {
    expect(didRestartRecover("recovered-via-rollback"), "recovered-via-rollback").toBe(true);
    expect(didRestartRecover("failed"), "failed").toBe(false);
    expect(didRestartRecover("invalid-release-candidate"), "invalid-release-candidate").toBe(false);
  });
});

describe("shouldPersistReleaseFailureState", () => {
  it("persists only when outcome is failed and failure metadata is pending", () => {
    expect(
      shouldPersistReleaseFailureState({ outcome: "failed", hasPendingReleaseFailure: true }),
      "failed + pending",
    ).toBe(true);

    // invalid-release-candidate clears stale pending state
    const outcome = resolveReleaseCandidateRestartOutcome({
      releaseCandidateRequested: true,
      releaseCandidateResolved: false,
    });
    expect(outcome).toBe("invalid-release-candidate");
    if (outcome === null) throw new Error("Expected invalid release candidate outcome");
    expect(
      shouldPersistReleaseFailureState({ outcome, hasPendingReleaseFailure: true }),
      "invalid-candidate + pending",
    ).toBe(false);

    expect(
      shouldPersistReleaseFailureState({ outcome: "failed", hasPendingReleaseFailure: false }),
      "failed + no pending",
    ).toBe(false);
  });
});

describe("resolveReleaseCandidateRestartOutcome", () => {
  it("returns no terminal outcome when no release candidate was requested or when it resolves", () => {
    expect(
      resolveReleaseCandidateRestartOutcome({
        releaseCandidateRequested: false,
        releaseCandidateResolved: false,
      }),
      "not requested",
    ).toBeNull();
    expect(
      resolveReleaseCandidateRestartOutcome({
        releaseCandidateRequested: true,
        releaseCandidateResolved: true,
      }),
      "requested and resolved",
    ).toBeNull();
  });

  describe("startAfterVerifiedStop", () => {
    it("never starts a replacement after an unverifiable stop", async () => {
      const startReplacement = vi.fn(() => ({ pid: 2 }));

      await expect(startAfterVerifiedStop(
        async () => false,
        startReplacement,
      )).resolves.toEqual({ stopped: false, replacement: null });
      expect(startReplacement).not.toHaveBeenCalled();
    });

    it("stops a failed candidate before starting rollback", async () => {
      const order: string[] = [];
      const result = await startAfterVerifiedStop(
        async () => {
          order.push("stop-candidate");
          return true;
        },
        () => {
          order.push("start-rollback");
          return { pid: 3 };
        },
      );

      expect(order).toEqual(["stop-candidate", "start-rollback"]);
      expect(result).toEqual({ stopped: true, replacement: { pid: 3 } });
    });
  });

  });

