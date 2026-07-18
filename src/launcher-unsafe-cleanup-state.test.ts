import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createServerRestartSafetyState,
  spawnServerIfRestartSafe,
} from "./launcher-process.js";
import {
  clearUnsafeServerCleanupState,
  persistUnsafeServerCleanupState,
  readUnsafeServerCleanupState,
  runWithDurableUnsafeCleanupState,
  type UnsafeCleanupStateFs,
} from "./launcher-unsafe-cleanup-state.js";
import {
  hasPersistentRollbackFailureState,
  markPersistentRollbackFailureState,
} from "./launcher-rollback-state.js";
import { decideLauncherStartup } from "./launcher-recovery.js";
import { makeTestDir } from "./server/__tests__/helpers.js";

const root = { pid: 123, startMarker: "start-123" };
const realFs: UnsafeCleanupStateFs = {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
};

function expectReloadedStartupBlocked(
  stateFile: string,
  fs: UnsafeCleanupStateFs = realFs,
): void {
  const reloaded = readUnsafeServerCleanupState(stateFile, fs);
  const safety = createServerRestartSafetyState(reloaded?.reason ?? null);
  const spawn = vi.fn(() => ({ pid: 456 }));
  expect(spawnServerIfRestartSafe(safety, () => false, spawn)).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
}

describe("persistent unsafe server cleanup state", () => {
  it("reloads before startup and suppresses replacement after launcher restart", () => {
    const stateFile = join(makeTestDir("unsafe-cleanup-startup"), "unsafe-server-cleanup.json");
    persistUnsafeServerCleanupState(stateFile, root, "unverified cleanup");

    const reloaded = readUnsafeServerCleanupState(stateFile);
    const safety = createServerRestartSafetyState(reloaded?.reason ?? null);
    const spawn = vi.fn(() => ({ pid: 456 }));

    expect(spawnServerIfRestartSafe(safety, () => false, spawn)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("writes atomically without leaving a temporary state file", () => {
    const dir = makeTestDir("unsafe-cleanup-atomic");
    const stateFile = join(dir, "unsafe-server-cleanup.json");

    const persisted = persistUnsafeServerCleanupState(stateFile, root, "cleanup started");

    expect(readUnsafeServerCleanupState(stateFile)).toEqual(persisted);
    expect(readdirSync(dir)).toEqual(["unsafe-server-cleanup.json"]);
  });

  it("fails closed when persisted state is malformed", () => {
    const stateFile = join(makeTestDir("unsafe-cleanup-malformed"), "unsafe-server-cleanup.json");
    writeFileSync(stateFile, "{not-json", "utf8");

    expect(readUnsafeServerCleanupState(stateFile)?.reason).toContain("unreadable");
  });

  it("fails closed when an interrupted atomic write leaves only a temp file", () => {
    const dir = makeTestDir("unsafe-cleanup-interrupted");
    const stateFile = join(dir, "unsafe-server-cleanup.json");
    writeFileSync(
      join(dir, ".unsafe-server-cleanup.json.interrupted.tmp"),
      "{}",
      "utf8",
    );

    expect(readUnsafeServerCleanupState(stateFile)?.reason).toContain("incomplete");
  });

  it("allows startup only after the explicit clear path removes persisted state", () => {
    const dir = makeTestDir("unsafe-cleanup-clear");
    const stateFile = join(dir, "unsafe-server-cleanup.json");
    persistUnsafeServerCleanupState(stateFile, root, "unverified cleanup");
    writeFileSync(join(dir, ".unsafe-server-cleanup.json.stale.tmp"), "{}", "utf8");

    clearUnsafeServerCleanupState(stateFile);

    expect(readdirSync(dir)).toEqual([]);
    const safety = createServerRestartSafetyState(
      readUnsafeServerCleanupState(stateFile)?.reason ?? null,
    );
    const replacement = { pid: 789 };
    expect(spawnServerIfRestartSafe(safety, () => false, () => replacement)).toBe(replacement);
  });

  it("does not run destructive cleanup when state writing fails without a marker", async () => {
    const dir = makeTestDir("unsafe-cleanup-write-failure");
    const stateFile = join(dir, "unsafe-server-cleanup.json");
    const rollbackMarker = join(dir, "rollback-required");
    const destructiveCleanup = vi.fn(async () => "killed");
    const failingFs: UnsafeCleanupStateFs = {
      ...realFs,
      writeFileSync: (() => {
        throw new Error("disk full");
      }) as typeof writeFileSync,
    };

    const result = await runWithDurableUnsafeCleanupState(
      () => persistUnsafeServerCleanupState(stateFile, root, "cleanup started", failingFs),
      destructiveCleanup,
    );

    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(destructiveCleanup).not.toHaveBeenCalled();
    markPersistentRollbackFailureState(rollbackMarker);
    expect(hasPersistentRollbackFailureState(rollbackMarker)).toBe(true);
    expect(decideLauncherStartup({
      restartSignalPresent: false,
      autoRecoverySuppressed: true,
    }).startServer).toBe(false);
  });

  it("preserves a temp marker and skips destructive cleanup when rename fails", async () => {
    const dir = makeTestDir("unsafe-cleanup-rename-failure");
    const stateFile = join(dir, "unsafe-server-cleanup.json");
    const destructiveCleanup = vi.fn(async () => "killed");
    const failingFs: UnsafeCleanupStateFs = {
      ...realFs,
      renameSync: (() => {
        throw new Error("rename denied");
      }) as typeof renameSync,
    };

    const result = await runWithDurableUnsafeCleanupState(
      () => persistUnsafeServerCleanupState(stateFile, root, "cleanup started", failingFs),
      destructiveCleanup,
    );

    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(destructiveCleanup).not.toHaveBeenCalled();
    expect(readdirSync(dir).some((entry) => entry.endsWith(".tmp"))).toBe(true);
    expectReloadedStartupBlocked(stateFile);
  });

  it("preserves a partial temp marker and skips destructive cleanup when writing fails", async () => {
    const dir = makeTestDir("unsafe-cleanup-partial-write");
    const stateFile = join(dir, "unsafe-server-cleanup.json");
    const destructiveCleanup = vi.fn(async () => "killed");
    const failingFs: UnsafeCleanupStateFs = {
      ...realFs,
      writeFileSync: ((path, data, options) => {
        writeFileSync(path, data, options);
        throw new Error("write interrupted");
      }) as typeof writeFileSync,
    };

    const result = await runWithDurableUnsafeCleanupState(
      () => persistUnsafeServerCleanupState(stateFile, root, "cleanup started", failingFs),
      destructiveCleanup,
    );

    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(destructiveCleanup).not.toHaveBeenCalled();
    expectReloadedStartupBlocked(stateFile);
  });

  it("skips destructive cleanup and keeps startup blocked when state reading fails", async () => {
    const stateFile = join(makeTestDir("unsafe-cleanup-read-failure"), "unsafe-server-cleanup.json");
    persistUnsafeServerCleanupState(stateFile, root, "cleanup started");
    const destructiveCleanup = vi.fn(async () => "killed");
    const failingFs: UnsafeCleanupStateFs = {
      ...realFs,
      readFileSync: (() => {
        throw new Error("read denied");
      }) as typeof readFileSync,
    };

    const result = await runWithDurableUnsafeCleanupState(
      () => persistUnsafeServerCleanupState(stateFile, root, "cleanup started", failingFs),
      destructiveCleanup,
    );

    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(destructiveCleanup).not.toHaveBeenCalled();
    expectReloadedStartupBlocked(stateFile);
  });
});
