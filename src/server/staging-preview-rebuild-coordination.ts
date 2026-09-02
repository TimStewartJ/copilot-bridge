import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagementJob } from "./management-job-store.js";
import { PROCESS_TREE_TERMINATION_BUDGET_MS } from "./platform.js";
import {
  STAGING_BACKEND_IDENTITY_RECAPTURE_TIMEOUT_MS,
  STAGING_BACKEND_REBUILD_STOP_MAX_ATTEMPTS,
  STAGING_BACKEND_REBUILD_STOP_RETRY_DELAY_MS,
  STAGING_BACKEND_STARTUP_TIMEOUT_MS,
} from "./staging-preview-shared.js";

const READY_FILE_SUFFIX = ".preview-rebuild-ready";
const DEFAULT_READY_TIMEOUT_MS =
  STAGING_BACKEND_REBUILD_STOP_MAX_ATTEMPTS
    * (
      STAGING_BACKEND_STARTUP_TIMEOUT_MS
      + STAGING_BACKEND_IDENTITY_RECAPTURE_TIMEOUT_MS
      + PROCESS_TREE_TERMINATION_BUDGET_MS
    )
  + STAGING_BACKEND_REBUILD_STOP_RETRY_DELAY_MS
  + 15_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 100;

export interface PreviewRebuildCoordination {
  jobId: string;
  readyPath: string;
}

export function createPreviewRebuildCoordination(
  job: ManagementJob,
): PreviewRebuildCoordination | null {
  if (job.type !== "staging_preview" || !job.logPath) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(job.id) || job.id.includes("..")) return null;
  return {
    jobId: job.id,
    readyPath: join(dirname(job.logPath), `${job.id}${READY_FILE_SUFFIX}`),
  };
}

export function signalPreviewRebuildReady(
  coordination: PreviewRebuildCoordination,
  prefix: string,
): void {
  mkdirSync(dirname(coordination.readyPath), { recursive: true });
  writeFileSync(
    coordination.readyPath,
    JSON.stringify({
      status: "ready",
      jobId: coordination.jobId,
      prefix,
      readyAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

export function signalPreviewRebuildFailure(
  coordination: PreviewRebuildCoordination,
  prefix: string,
  error: string,
): void {
  mkdirSync(dirname(coordination.readyPath), { recursive: true });
  writeFileSync(
    coordination.readyPath,
    JSON.stringify({
      status: "failed",
      jobId: coordination.jobId,
      prefix,
      error,
      failedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

export function clearPreviewRebuildReady(
  coordination: PreviewRebuildCoordination | null,
): void {
  if (!coordination) return;
  rmSync(coordination.readyPath, { force: true });
}

export async function waitForPreviewRebuildReady(
  coordination: PreviewRebuildCoordination,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (existsSync(coordination.readyPath)) {
      const raw = readFileSync(coordination.readyPath, "utf8");
      let payload: unknown;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        payload = null;
      }
      if (
        payload
        && typeof payload === "object"
        && (payload as { status?: unknown }).status === "failed"
      ) {
        const error = (payload as { error?: unknown }).error;
        throw new Error(
          typeof error === "string" && error
            ? error
            : `The live server could not stop the existing staged backend for management job ${coordination.jobId}.`,
        );
      }
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out after ${Math.ceil(timeoutMs / 1_000)} seconds waiting for the live server `
        + `to stop the existing staged backend for management job ${coordination.jobId}.`,
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, remaining));
    });
  }
}
