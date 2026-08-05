import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestDir } from "./server/__tests__/helpers.js";

describe("persistent rollback failure state", () => {
  it("writes atomically and survives a module reload until explicitly cleared", async () => {
    const marker = join(makeTestDir("launcher-rollback-state"), "data", "rollback-required");
    const first = await import("./launcher-rollback-state.js");

    expect(first.hasPersistentRollbackFailureState(marker)).toBe(false);
    first.markPersistentRollbackFailureState(marker);
    expect(first.hasPersistentRollbackFailureState(marker)).toBe(true);
    expect(
      readdirSync(dirname(marker)).filter((entry) => entry.startsWith(`.${basename(marker)}.`)),
    ).toEqual([]);

    vi.resetModules();
    const afterRestart = await import("./launcher-rollback-state.js");
    expect(afterRestart.hasPersistentRollbackFailureState(marker)).toBe(true);

    afterRestart.clearPersistentRollbackFailureState(marker);
    expect(afterRestart.hasPersistentRollbackFailureState(marker)).toBe(false);
    expect(() => afterRestart.clearPersistentRollbackFailureState(marker)).not.toThrow();
  });

  it("surfaces marker read, mark, and clear failures", async () => {
    const mod = await import("./launcher-rollback-state.js");
    const invalidPath = "\0rollback-required";

    expect(() => mod.hasPersistentRollbackFailureState(invalidPath)).toThrow();
    expect(() => mod.markPersistentRollbackFailureState(invalidPath)).toThrow();

    const directoryMarker = join(makeTestDir("launcher-rollback-clear-failure"), "rollback-required");
    mkdirSync(directoryMarker, { recursive: true });
    expect(mod.hasPersistentRollbackFailureState(directoryMarker)).toBe(true);
    expect(() => mod.clearPersistentRollbackFailureState(directoryMarker)).toThrow();
    expect(mod.hasPersistentRollbackFailureState(directoryMarker)).toBe(true);
  });
});
