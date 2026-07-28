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
  it("returns false when suppressed and true otherwise", () => {
    expect(shouldCheckFollowUpRecovery({ autoRecoverySuppressed: true }), "suppressed").toBe(false);
    expect(shouldCheckFollowUpRecovery({ autoRecoverySuppressed: false }), "not suppressed").toBe(true);
  });
});

describe("shouldClearRollbackCheckpointAfterHealthyState", () => {
  it("clears only when no restart is pending and auto-recovery is not suppressed", () => {
    const cases: [boolean, boolean, boolean][] = [
      // restartSignalPresent, autoRecoverySuppressed, expected
      [false, false, true],
      [true, false, false],
      [false, true, false],
    ];
    for (const [restartSignalPresent, autoRecoverySuppressed, expected] of cases) {
      expect(
        shouldClearRollbackCheckpointAfterHealthyState({ restartSignalPresent, autoRecoverySuppressed }),
        `restart=${restartSignalPresent} suppressed=${autoRecoverySuppressed}`,
      ).toBe(expected);
    }
  });
});

describe("decideLauncherStartup", () => {
  it("maps all input combinations to the correct startup decision", () => {
    type Case = [boolean, boolean, { startServer: boolean; clearRestartSignal: boolean; logMessage?: string }];
    const cases: Case[] = [
      // restartSignalPresent=false, autoRecoverySuppressed=false → start normally
      [false, false, { startServer: true, clearRestartSignal: true }],
      // restartSignalPresent=false, autoRecoverySuppressed=true → stay stopped (rollback required)
      [false, true, {
        startServer: false,
        clearRestartSignal: false,
        logMessage: "Rollback recovery required — staying stopped until an explicit restart succeeds",
      }],
      // restartSignalPresent=true, autoRecoverySuppressed=false → honor queued restart
      [true, false, {
        startServer: false,
        clearRestartSignal: false,
        logMessage: "Queued restart detected — honoring pending restart before normal startup",
      }],
      // restartSignalPresent=true, autoRecoverySuppressed=true → honor queued explicit recovery
      [true, true, {
        startServer: false,
        clearRestartSignal: false,
        logMessage: "Queued restart detected — honoring explicit recovery while rollback recovery remains required",
      }],
    ];
    for (const [restartSignalPresent, autoRecoverySuppressed, expected] of cases) {
      expect(
        decideLauncherStartup({ restartSignalPresent, autoRecoverySuppressed }),
        `restart=${restartSignalPresent} suppressed=${autoRecoverySuppressed}`,
      ).toEqual(expected);
    }
  });
});
