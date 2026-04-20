import { describe, expect, it } from "vitest";
import {
  decideLauncherStartup,
  decideRecoveryExecution,
  shouldCheckFollowUpRecovery,
  shouldClearRollbackCheckpointAfterHealthyState,
} from "./launcher-recovery.js";

describe("decideRecoveryExecution", () => {
  it("prefers a full restart when a restart signal is pending", () => {
    expect(
      decideRecoveryExecution({
        restartSignalPresent: true,
        autoRecoverySuppressed: true,
      }),
    ).toEqual({ type: "restart" });
  });

  it("suppresses auto-recovery while waiting for an explicit restart", () => {
    expect(
      decideRecoveryExecution({
        restartSignalPresent: false,
        autoRecoverySuppressed: true,
      }),
    ).toEqual({
      type: "skip",
      logMessage: "Auto-recovery suppressed — waiting for an explicit restart signal",
    });
  });

  it("allows normal recovery when no restart is queued and suppression is off", () => {
    expect(
      decideRecoveryExecution({
        restartSignalPresent: false,
        autoRecoverySuppressed: false,
      }),
    ).toEqual({ type: "recover" });
  });
});

describe("shouldCheckFollowUpRecovery", () => {
  it("skips follow-up recovery while auto-recovery is suppressed", () => {
    expect(shouldCheckFollowUpRecovery({ autoRecoverySuppressed: true })).toBe(false);
  });

  it("allows follow-up recovery checks when suppression is off", () => {
    expect(shouldCheckFollowUpRecovery({ autoRecoverySuppressed: false })).toBe(true);
  });
});

describe("shouldClearRollbackCheckpointAfterHealthyState", () => {
  it("clears a checkpoint after healthy state when no restart is pending", () => {
    expect(
      shouldClearRollbackCheckpointAfterHealthyState({
        restartSignalPresent: false,
        autoRecoverySuppressed: false,
      }),
    ).toBe(true);
  });

  it("keeps the checkpoint while a restart is still pending", () => {
    expect(
      shouldClearRollbackCheckpointAfterHealthyState({
        restartSignalPresent: true,
        autoRecoverySuppressed: false,
      }),
    ).toBe(false);
  });

  it("keeps the checkpoint while auto-recovery is suppressed", () => {
    expect(
      shouldClearRollbackCheckpointAfterHealthyState({
        restartSignalPresent: false,
        autoRecoverySuppressed: true,
      }),
    ).toBe(false);
  });
});

describe("decideLauncherStartup", () => {
  it("stays stopped on startup when durable rollback recovery is required", () => {
    expect(
      decideLauncherStartup({
        restartSignalPresent: false,
        autoRecoverySuppressed: true,
      }),
    ).toEqual({
      startServer: false,
      clearRestartSignal: false,
      logMessage: "Rollback recovery required — staying stopped until an explicit restart succeeds",
    });
  });

  it("starts normally when no durable rollback recovery is required", () => {
    expect(
      decideLauncherStartup({
        restartSignalPresent: false,
        autoRecoverySuppressed: false,
      }),
    ).toEqual({
      startServer: true,
      clearRestartSignal: true,
    });
  });

  it("honors a queued restart signal on startup instead of direct-booting", () => {
    expect(
      decideLauncherStartup({
        restartSignalPresent: true,
        autoRecoverySuppressed: false,
      }),
    ).toEqual({
      startServer: false,
      clearRestartSignal: false,
      logMessage: "Queued restart detected — honoring pending restart before normal startup",
    });
  });

  it("honors a queued explicit recovery on startup even when rollback recovery is required", () => {
    expect(
      decideLauncherStartup({
        restartSignalPresent: true,
        autoRecoverySuppressed: true,
      }),
    ).toEqual({
      startServer: false,
      clearRestartSignal: false,
      logMessage: "Queued restart detected — honoring explicit recovery while rollback recovery remains required",
    });
  });
});
