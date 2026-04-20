import { beforeEach, describe, expect, it, vi } from "vitest";

const fileState = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", () => ({
  existsSync: (path: string) => fileState.has(String(path)),
  mkdirSync: () => undefined,
  unlinkSync: (path: string) => {
    fileState.delete(String(path));
  },
  writeFileSync: (path: string, data: string) => {
    fileState.set(String(path), data);
  },
}));

import {
  clearPersistentRollbackFailureState,
  hasPersistentRollbackFailureState,
  markPersistentRollbackFailureState,
} from "./launcher-rollback-state.js";

describe("launcher rollback state", () => {
  const markerFile = "/repo/data/rollback-required";

  beforeEach(() => {
    fileState.clear();
  });

  it("persists failed rollback state across launcher restarts", () => {
    expect(hasPersistentRollbackFailureState(markerFile)).toBe(false);

    markPersistentRollbackFailureState(markerFile);

    expect(hasPersistentRollbackFailureState(markerFile)).toBe(true);
  });

  it("clears persisted failed rollback state after explicit recovery", () => {
    markPersistentRollbackFailureState(markerFile);

    clearPersistentRollbackFailureState(markerFile);

    expect(hasPersistentRollbackFailureState(markerFile)).toBe(false);
  });

  it("keeps persisted failed rollback state until recovery actually succeeds", () => {
    markPersistentRollbackFailureState(markerFile);

    expect(hasPersistentRollbackFailureState(markerFile)).toBe(true);
  });
});
