// Worker entry kept for processes that started before the process host moved to
// src/packages/spawn-offthread. The launcher and the management job runner run from this
// checkout's source and keep the host they started with in memory. That older host starts every
// worker thread from this path, so a deploy that removed the file would break process creation
// in exactly the process that is running the deploy. The message protocol is unchanged, so this
// module only has to start the package's worker under the flag it now expects.
//
// Nothing in the current source loads this file. Remove it once the launcher has been fully
// restarted on a release that includes the move.

import { workerData } from "node:worker_threads";

const startedBy = workerData as Record<string, unknown> | null;
if (startedBy?.bridgeProcessHostWorker === true) startedBy.spawnOffthreadWorker = true;

// A worker thread started from TypeScript source gets no ".js means .ts" mapping for what it
// imports, so the package's worker is named with the extension this file itself was loaded with.
const packageWorker = new URL(
  `../packages/spawn-offthread/src/worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
);

// The same older host imports these when it runs inline (BRIDGE_PROCESS_HOST=inline).
export const { execToOutcome, forkOnCallingThread, removeTreeOnCallingThread, spawnOnCallingThread } =
  await import(packageWorker.href) as typeof import("../packages/spawn-offthread/src/worker.js");
