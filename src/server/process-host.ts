// The server runtime's only way to start a child process. Every process is created on a worker
// thread, so a slow CreateProcessW never stalls the server's event loop (see
// .github/instructions/server-runtime.instructions.md). The mechanism is the in-tree package
// src/packages/spawn-offthread; this module owns the Bridge's process-wide host and its policy.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProcessHost, type ProcessHostMode, type ProcessLaunchObservation } from "../packages/spawn-offthread/src/index.js";

export {
  HostExecError,
  ProcessHost,
  type HostChild,
  type HostExecOptions,
  type HostWorker,
  type ProcessHostMode,
  type ProcessHostOptions,
  type ProcessLaunchObservation,
} from "../packages/spawn-offthread/src/index.js";

/**
 * Locates a worker module that sits beside the caller, such as "cli-session-store-worker".
 * Compiled builds load the .js worker and inherit execArgv. Source runs (tsx, Vitest) load the
 * .ts worker with the tsx loader passed explicitly: loader hooks registered by a tsx parent are
 * not reliably inherited by worker threads. Inherited execArgv is never re-passed, because
 * `new Worker` rejects process-level flags that inheritance silently tolerates.
 *
 * A worker thread loaded from source gets no ".js means .ts" mapping for its own imports, so a
 * module that runs as a worker thread imports nothing from the codebase at run time (type imports
 * are erased). A child process started with the same execArgv has the loader in full.
 */
export function resolveWorkerEntry(name: string, moduleUrl = import.meta.url): { entry: string; execArgv?: string[] } {
  const isSource = moduleUrl.endsWith(".ts");
  const entry = join(dirname(fileURLToPath(moduleUrl)), `${name}.${isSource ? "ts" : "js"}`);
  if (isSource) {
    return { entry, execArgv: ["--import", pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href] };
  }
  return { entry };
}

let defaultHost: ProcessHost | undefined;
let launchObserver: ((observation: ProcessLaunchObservation) => void) | undefined;

function resolveDefaultMode(): ProcessHostMode {
  const configured = process.env.BRIDGE_PROCESS_HOST;
  if (configured === "inline" || configured === "worker") return configured;
  // Test suites mock node:child_process on their own thread, which a worker thread cannot see.
  return process.env.NODE_ENV === "test" ? "inline" : "worker";
}

/** The process-wide host. Created on first use so importing this module starts no threads. */
export function getProcessHost(): ProcessHost {
  return (defaultHost ??= new ProcessHost({
    mode: resolveDefaultMode(),
    onLaunch: (observation) => launchObserver?.(observation),
    onUnhandledChildError: (error, pid) => {
      console.warn(`[process-host] Unhandled child process error (pid ${pid}): ${error.message}`);
    },
  }));
}

export function setProcessLaunchObserver(observer: ((observation: ProcessLaunchObservation) => void) | undefined): void {
  launchObserver = observer;
}

/** Test hook: drops the process-wide host so the next use re-reads the environment. */
export async function resetProcessHostForTests(): Promise<void> {
  const host = defaultHost;
  defaultHost = undefined;
  await host?.shutdown();
}
