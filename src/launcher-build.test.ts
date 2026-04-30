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

  it("uses the fast deploy validation contract instead of coverage", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: true, output: "" }));
    const log = vi.fn();

    expect(runLauncherBuild({ ensureDeps, run, log })).toBe(true);

    expect(run.mock.calls).toEqual([
      ["npm run test:xplat-audit", { timeoutMs: 600_000, isolateRuntimeEnv: true }],
      ["npx tsc --noEmit", { timeoutMs: 600_000, isolateRuntimeEnv: true }],
      ["npx vitest run", { timeoutMs: 600_000, isolateRuntimeEnv: true }],
      ["npx vite build", { timeoutMs: 600_000, isolateRuntimeEnv: true }],
    ]);
  });

  it("logs deploy validation failures without running rollback", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: false, output: "plain vitest failed" }));
    const log = vi.fn();

    expect(runLauncherBuild({ ensureDeps, run, log })).toBe(false);

    expect(log).toHaveBeenCalledWith("Deploy validation failed:\nplain vitest failed");
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

  it("runs only the runtime rollback validation gate", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: true, output: "" }));
    const log = vi.fn();

    expect(rebuildAfterRollback({ ensureDeps, run, log })).toBe(true);

    expect(run.mock.calls).toEqual([
      ["npx vite build", { timeoutMs: 480_000, isolateRuntimeEnv: true }],
    ]);
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
