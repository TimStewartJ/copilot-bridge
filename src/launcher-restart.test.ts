import { describe, expect, it } from "vitest";
import {
  didRestartRecover,
  resolveRollbackRecoveryOutcome,
  rollbackRecoveryRequiresServerStart,
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
});
