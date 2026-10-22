import { rm } from "node:fs/promises";
import type { CopilotBackend } from "../agent-backend/copilot-backend.js";
import { throwCleanupErrors } from "./helpers.js";

/**
 * Stops a native test's Copilot CLI and waits until its whole process tree has exited, then removes
 * `removeDir` if given. stop() waits for the loader process only; the native runtime under it keeps
 * its working directory open, so temp folders cannot be removed until fence() has seen every process
 * of the tree exit. The backend must be built with `localStdioOwnership: true`. Every failure is
 * reported after all steps have run.
 */
export async function stopCopilotRuntime(backend: CopilotBackend, removeDir?: string): Promise<void> {
  const errors: unknown[] = [];
  const status = backend.getConnectionStatus();
  // A runtime that never spawned has no tree to prove gone.
  const spawned = status.pid !== undefined || status.runtimePids !== undefined;
  await backend.stop().catch((error: unknown) => { errors.push(error); });
  if (spawned) await backend.fence().catch((error: unknown) => { errors.push(error); });
  if (removeDir) {
    await rm(removeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
      .catch((error: unknown) => { errors.push(error); });
  }
  throwCleanupErrors(errors, "Copilot test runtime cleanup failed");
}
