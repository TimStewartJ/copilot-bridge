import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ManagementJob } from "../management-job-store.js";
import {
  clearPreviewRebuildReady,
  createPreviewRebuildCoordination,
  signalPreviewRebuildFailure,
  signalPreviewRebuildReady,
  waitForPreviewRebuildReady,
} from "../staging-preview-rebuild-coordination.js";
import { makeTestDir } from "./helpers.js";

function createJob(): ManagementJob {
  const createdAt = new Date().toISOString();
  const dataDir = makeTestDir("preview-rebuild-coordination");
  return {
    id: "preview-job-123",
    type: "staging_preview",
    status: "running",
    input: { stagingDir: join(dataDir, "worktree") },
    logPath: join(dataDir, "management-jobs", "logs", "preview-job-123.log"),
    createdAt,
    updatedAt: createdAt,
  };
}

describe("staging preview rebuild coordination", () => {
  it("releases the runner only after the live server signals readiness", async () => {
    const coordination = createPreviewRebuildCoordination(createJob());
    if (!coordination) throw new Error("expected preview rebuild coordination");

    signalPreviewRebuildReady(coordination, "preview-123");
    await expect(waitForPreviewRebuildReady(coordination)).resolves.toBeUndefined();
    expect(existsSync(coordination.readyPath)).toBe(true);

    clearPreviewRebuildReady(coordination);
    expect(existsSync(coordination.readyPath)).toBe(false);
  });

  it("surfaces live-server teardown failures without waiting for timeout", async () => {
    const coordination = createPreviewRebuildCoordination(createJob());
    if (!coordination) throw new Error("expected preview rebuild coordination");

    signalPreviewRebuildFailure(coordination, "preview-123", "backend process did not stop");

    await expect(waitForPreviewRebuildReady(coordination))
      .rejects.toThrow("backend process did not stop");
  });
});
