import { readdirSync, writeFileSync } from "node:fs";
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
} from "./launcher-unsafe-cleanup-state.js";
import { makeTestDir } from "./server/__tests__/helpers.js";

const root = { pid: 123, startMarker: "start-123" };

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
});
