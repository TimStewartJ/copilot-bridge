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

  it("uses the production-safe deploy validation contract instead of coverage", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: true, output: "" }));
    const log = vi.fn();

    expect(runLauncherBuild({ ensureDeps, run, log })).toBe(true);

    expect(run.mock.calls).toEqual([
      ["npm run check:deploy", { timeoutMs: 600_000, isolateRuntimeEnv: true }],
    ]);
  });

  it("uses a stamped deploy build when trusted or falls back to full validation otherwise", () => {
    // When the current commit was already validated, only runs production build
    const run1 = vi.fn(() => ({ ok: true, output: "" }));
    const log1 = vi.fn();
    expect(runLauncherBuild({
      ensureDeps: vi.fn(() => true),
      run: run1,
      log: log1,
      resolveDeployValidationStamp: () => ({
        valid: true,
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    })).toBe(true);
    expect(run1.mock.calls).toEqual([
      ["npm run build", { timeoutMs: 600_000, isolateRuntimeEnv: true }],
    ]);
    expect(log1).toHaveBeenCalledWith(
      "Deploy validation already passed for aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa — running production build only",
    );

    // When stamp is not trusted, falls back to full validation
    const run2 = vi.fn(() => ({ ok: true, output: "" }));
    const log2 = vi.fn();
    expect(runLauncherBuild({
      ensureDeps: vi.fn(() => true),
      run: run2,
      log: log2,
      resolveDeployValidationStamp: () => ({
        valid: false,
        reason: "stamp dependency hash does not match current dependencies",
      }),
    })).toBe(true);
    expect(run2.mock.calls).toEqual([
      ["npm run check:deploy", { timeoutMs: 600_000, isolateRuntimeEnv: true }],
    ]);
    expect(log2).toHaveBeenCalledWith(
      "Deploy validation stamp not used: stamp dependency hash does not match current dependencies",
    );
  });

  it("logs deploy validation failures without running rollback", () => {
    const ensureDeps = vi.fn(() => true);
    const run = vi.fn(() => ({ ok: false, output: "plain vitest failed" }));
    const log = vi.fn();

    expect(runLauncherBuild({ ensureDeps, run, log })).toBe(false);

    expect(log).toHaveBeenCalledWith("Deploy validation failed:\nplain vitest failed");
  });

  it("skips or keeps deploy validation for operational restarts depending on source changes", () => {
    // No source changes: skip validation
    const run1 = vi.fn((_cmd: string) => ({ ok: true, output: "" }));
    const log1 = vi.fn();
    expect(runLauncherBuild({
      ensureDeps: vi.fn(() => true),
      run: run1,
      log: log1,
      validationMode: "operational",
      hasSourceChanges: () => false,
    })).toBe(true);
    expect(run1).not.toHaveBeenCalled();
    expect(log1).toHaveBeenCalledWith("Operational restart validation skipped — no source changes detected");

    // Source changed: run full validation
    const run2 = vi.fn((_cmd: string) => ({ ok: true, output: "" }));
    const log2 = vi.fn();
    expect(runLauncherBuild({
      ensureDeps: vi.fn(() => true),
      run: run2,
      log: log2,
      validationMode: "operational",
      hasSourceChanges: () => true,
    })).toBe(true);
    expect(run2.mock.calls.map(([cmd]) => cmd)).toEqual(["npm run check:deploy"]);
    expect(log2).toHaveBeenCalledWith("Operational restart found source changes — running deploy validation");
  });
});

describe("rebuildAfterRollback", () => {
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
  it("clears the checkpoint on success and restores it on failure", () => {
    // Successful rollback: clears checkpoint, does not restore
    expect(
      runLauncherRollbackWithCheckpointHandling({
        rollbackTarget: "abc123",
        ensureDeps: vi.fn(() => true),
        run: vi.fn(() => ({ ok: true, output: "" })),
        log: vi.fn(),
        clearCheckpoint: vi.fn(),
        restoreCheckpoint: vi.fn(),
      }),
    ).toBe(true);
    const clearMock1 = vi.fn();
    const restoreMock1 = vi.fn();
    runLauncherRollbackWithCheckpointHandling({
      rollbackTarget: "abc123",
      ensureDeps: vi.fn(() => true),
      run: vi.fn(() => ({ ok: true, output: "" })),
      log: vi.fn(),
      clearCheckpoint: clearMock1,
      restoreCheckpoint: restoreMock1,
    });
    expect(clearMock1).toHaveBeenCalledOnce();
    expect(restoreMock1).not.toHaveBeenCalled();

    // Failed rollback: restores checkpoint, does not clear
    const clearMock2 = vi.fn();
    const restoreMock2 = vi.fn();
    expect(
      runLauncherRollbackWithCheckpointHandling({
        rollbackTarget: "abc123",
        ensureDeps: vi.fn(() => true),
        run: vi.fn(() => ({ ok: false, output: "reset failed" })),
        log: vi.fn(),
        clearCheckpoint: clearMock2,
        restoreCheckpoint: restoreMock2,
      }),
    ).toBe(false);
    expect(clearMock2).not.toHaveBeenCalled();
    expect(restoreMock2).toHaveBeenCalledOnce();
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
