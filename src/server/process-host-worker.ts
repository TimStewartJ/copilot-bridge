// Old in-memory launchers still start workers from this path; keep until they restart past the move

import { workerData } from "node:worker_threads";

const startedBy = workerData as Record<string, unknown> | null;
if (startedBy?.bridgeProcessHostWorker === true) startedBy.spawnOffthreadWorker = true;

// A source-started worker gets no .js-to-.ts mapping, so use this file's own extension.
const packageWorker = new URL(
  `../packages/spawn-offthread/src/worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
);

// The same older host imports these when it runs inline (BRIDGE_PROCESS_HOST=inline).
export const { execToOutcome, forkOnCallingThread, removeTreeOnCallingThread, spawnOnCallingThread } =
  await import(packageWorker.href) as typeof import("../packages/spawn-offthread/src/worker.js");
