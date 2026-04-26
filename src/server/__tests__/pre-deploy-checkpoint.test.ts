import { beforeEach, describe, expect, it, vi } from "vitest";

const fileState = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", () => ({
  existsSync: (path: string) => fileState.has(String(path)),
  readFileSync: (path: string) => {
    const value = fileState.get(String(path));
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  },
  unlinkSync: (path: string) => {
    fileState.delete(String(path));
  },
  writeFileSync: (path: string, data: string) => {
    fileState.set(String(path), data);
  },
}));

import {
  clearRollbackCheckpoint,
  preserveOrCreateRollbackCheckpoint,
  removeRollbackCheckpointIfCreated,
} from "../pre-deploy-checkpoint.js";

describe("pre-deploy checkpoint lifecycle", () => {
  const checkpointPath = "/repo/data/pre-deploy-sha";

  beforeEach(() => {
    fileState.clear();
  });

  it("creates a checkpoint when none exists", () => {
    const checkpoint = preserveOrCreateRollbackCheckpoint(checkpointPath, "sha-1");

    expect(checkpoint).toEqual({
      sha: "sha-1",
      createdByCurrentOperation: true,
    });
    expect(fileState.get(checkpointPath)).toBe("sha-1");
  });

  it("refreshes the checkpoint after a successful operation clears the old one", () => {
    fileState.set(checkpointPath, "old-sha");

    const preserved = preserveOrCreateRollbackCheckpoint(checkpointPath, "new-sha");
    expect(preserved).toEqual({
      sha: "old-sha",
      createdByCurrentOperation: false,
    });

    clearRollbackCheckpoint(checkpointPath);
    expect(fileState.has(checkpointPath)).toBe(false);

    const refreshed = preserveOrCreateRollbackCheckpoint(checkpointPath, "new-sha");
    expect(refreshed).toEqual({
      sha: "new-sha",
      createdByCurrentOperation: true,
    });
    expect(fileState.get(checkpointPath)).toBe("new-sha");
  });

  it("removes the checkpoint only when createdByCurrentOperation is true", () => {
    const checkpoint = preserveOrCreateRollbackCheckpoint(checkpointPath, "sha-remove");
    expect(checkpoint.createdByCurrentOperation).toBe(true);
    expect(fileState.has(checkpointPath)).toBe(true);

    removeRollbackCheckpointIfCreated(checkpointPath, checkpoint);
    expect(fileState.has(checkpointPath)).toBe(false);
  });

  it("does not remove the checkpoint when createdByCurrentOperation is false", () => {
    fileState.set(checkpointPath, "sha-preserve");

    const checkpoint = preserveOrCreateRollbackCheckpoint(checkpointPath, "sha-other");
    expect(checkpoint.createdByCurrentOperation).toBe(false);
    expect(fileState.get(checkpointPath)).toBe("sha-preserve");

    removeRollbackCheckpointIfCreated(checkpointPath, checkpoint);
    expect(fileState.get(checkpointPath)).toBe("sha-preserve");
  });

  it("handles empty fallbackSha gracefully", () => {
    const checkpoint = preserveOrCreateRollbackCheckpoint(checkpointPath, "");
    expect(checkpoint).toEqual({ sha: "", createdByCurrentOperation: false });
    expect(fileState.has(checkpointPath)).toBe(false);
  });
});
