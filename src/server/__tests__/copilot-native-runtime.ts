import { rm } from "node:fs/promises";
import type { CopilotBackend } from "../agent-backend/copilot-backend.js";
import { throwCleanupErrors } from "./helpers.js";

/** stop() awaits only the loader; fence() awaits the tree using cwd. Needs localStdioOwnership. */
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
