import { describe, expect, it } from "vitest";
import {
  didRestartRecover,
  resolveReleaseCandidateRestartOutcome,
  resolveRollbackRecoveryOutcome,
  rollbackRecoveryRequiresServerStart,
  shouldPersistReleaseFailureState,
} from "./launcher-restart.js";

describe("rollbackRecoveryRequiresServerStart", () => {
  it("does not restart a rolled-back server when the original server was still running", () => {
    expect(rollbackRecoveryRequiresServerStart({ hadRunningServerAtStart: true })).toBe(false);
  });

  it("restarts a rolled-back server when recovery began from a stopped state", () => {
    expect(rollbackRecoveryRequiresServerStart({ hadRunningServerAtStart: false })).toBe(true);
  });
});

describe("resolveRollbackRecoveryOutcome", () => {
  it("treats rollback as successful recovery when the original server stayed running", () => {
    expect(
      resolveRollbackRecoveryOutcome({
        rollbackSucceeded: true,
        hadRunningServerAtStart: true,
      }),
    ).toBe("recovered-via-rollback");
  });

  it("treats rollback as successful recovery after a stopped-state restart only when the rolled-back server is healthy", () => {
    expect(
      resolveRollbackRecoveryOutcome({
        rollbackSucceeded: true,
        hadRunningServerAtStart: false,
        rolledBackServerHealthy: true,
      }),
    ).toBe("recovered-via-rollback");
  });

  it("treats rollback recovery as failed when the rolled-back server never becomes healthy", () => {
    expect(
      resolveRollbackRecoveryOutcome({
        rollbackSucceeded: true,
        hadRunningServerAtStart: false,
        rolledBackServerHealthy: false,
      }),
    ).toBe("failed");
  });
});

describe("didRestartRecover", () => {
  it("recognizes rollback recovery as a successful explicit recovery", () => {
    expect(didRestartRecover("recovered-via-rollback")).toBe(true);
  });

  it("recognizes failed recovery as unsuccessful", () => {
    expect(didRestartRecover("failed")).toBe(false);
  });

  it("recognizes invalid release candidates as unsuccessful", () => {
    expect(didRestartRecover("invalid-release-candidate")).toBe(false);
  });
});

describe("shouldPersistReleaseFailureState", () => {
  it("persists release failure state for failed outcomes with pending failure metadata", () => {
    expect(
      shouldPersistReleaseFailureState({
        outcome: "failed",
        hasPendingReleaseFailure: true,
      }),
    ).toBe(true);
  });

  it("clears stale pending release failure state for invalid candidate signals", () => {
    const outcome = resolveReleaseCandidateRestartOutcome({
      releaseCandidateRequested: true,
      releaseCandidateResolved: false,
    });

    expect(outcome).toBe("invalid-release-candidate");
    if (outcome === null) {
      throw new Error("Expected invalid release candidate outcome");
    }
    expect(
      shouldPersistReleaseFailureState({
        outcome,
        hasPendingReleaseFailure: true,
      }),
    ).toBe(false);
  });

  it("clears failed restart state when no release failure metadata is pending", () => {
    expect(
      shouldPersistReleaseFailureState({
        outcome: "failed",
        hasPendingReleaseFailure: false,
      }),
    ).toBe(false);
  });
});

describe("resolveReleaseCandidateRestartOutcome", () => {
  it("returns no terminal outcome when no release candidate was requested", () => {
    expect(
      resolveReleaseCandidateRestartOutcome({
        releaseCandidateRequested: false,
        releaseCandidateResolved: false,
      }),
    ).toBeNull();
  });

  it("returns no terminal outcome when the requested release candidate resolves", () => {
    expect(
      resolveReleaseCandidateRestartOutcome({
        releaseCandidateRequested: true,
        releaseCandidateResolved: true,
      }),
    ).toBeNull();
  });
});
