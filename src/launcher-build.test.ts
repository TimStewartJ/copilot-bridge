import { describe, expect, it, vi } from "vitest";
import {
  rebuildAfterRollback,
  runLauncherBuild,
  runLauncherRollback,
  runLauncherRollbackWithCheckpointHandling,
  verifyLauncherStartup,
} from "./launcher-build.js";

describe("runLauncherBuild", () => {
  it("fails fast when dependency sync fails", () => {
    const ensureDeps = vi.fn(() => false);
    const run = vi.fn();
    const log = vi.fn();

    expect(runLauncherBuild({ ensureDeps, run, log })).toBe(false);

    expect(ensureDeps).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenNthCalledWith(1, "Building...");
    expect(log).toHaveBeenNthCalledWith(2, "Dependency sync failed — aborting build");
  });

  it("allows extra time for coverage tests during builds", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: true, output: "" }));
    const log = vi.fn();

    expect(runLauncherBuild({ ensureDeps, run, log })).toBe(true);

    expect(run).toHaveBeenCalledWith("npx vitest run --coverage", { timeoutMs: 600_000 });
  });
});

describe("rebuildAfterRollback", () => {
  it("fails fast when dependency sync fails during rollback", () => {
    const ensureDeps = vi.fn(() => false);
    const run = vi.fn();
    const log = vi.fn();

    expect(rebuildAfterRollback({ ensureDeps, run, log })).toBe(false);

    expect(ensureDeps).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Dependency sync failed during rollback");
  });
});

describe("runLauncherRollback", () => {
  it("fails fast when git reset fails", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn((cmd: string) =>
      cmd.startsWith("git reset --hard")
        ? { ok: false, output: "reset failed" }
        : { ok: true, output: "" },
    );
    const log = vi.fn();

    expect(runLauncherRollback({ rollbackTarget: "abc123", ensureDeps, run, log })).toBe(false);

    expect(ensureDeps).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Rollback git reset failed:\nreset failed");
  });
});

describe("runLauncherRollbackWithCheckpointHandling", () => {
  it("clears the checkpoint only after rollback succeeds", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: true, output: "" }));
    const log = vi.fn();
    const clearCheckpoint = vi.fn();
    const restoreCheckpoint = vi.fn();

    expect(
      runLauncherRollbackWithCheckpointHandling({
        rollbackTarget: "abc123",
        ensureDeps,
        run,
        log,
        clearCheckpoint,
        restoreCheckpoint,
      }),
    ).toBe(true);

    expect(clearCheckpoint).toHaveBeenCalledOnce();
    expect(restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("restores the checkpoint when rollback fails", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: false, output: "reset failed" }));
    const log = vi.fn();
    const clearCheckpoint = vi.fn();
    const restoreCheckpoint = vi.fn();

    expect(
      runLauncherRollbackWithCheckpointHandling({
        rollbackTarget: "abc123",
        ensureDeps,
        run,
        log,
        clearCheckpoint,
        restoreCheckpoint,
      }),
    ).toBe(false);

    expect(clearCheckpoint).not.toHaveBeenCalled();
    expect(restoreCheckpoint).toHaveBeenCalledOnce();
  });
});

describe("verifyLauncherStartup", () => {
  it("fails startup when dependency sync fails", () => {
    const ensureDeps = vi.fn(() => false);
    const log = vi.fn();

    expect(verifyLauncherStartup({ ensureDeps, log })).toBe(false);

    expect(ensureDeps).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Dependency sync failed during startup");
  });
});
