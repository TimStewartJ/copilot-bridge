// The server's only way to start a child process; spawns on worker threads via spawn-offthread.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProcessHost, type HostExecOptions, type ProcessHostMode, type ProcessLaunchObservation } from "../packages/spawn-offthread/src/index.js";
import type { ShellCommand } from "./shell-command.js";

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

/** Source-run worker threads lack .js->.ts mapping: no codebase imports; see process-host.test. */
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

/** The host as the Bridge uses it: `exec` runs only constant shell text (see shell-command.ts). */
export type BridgeProcessHost = Omit<ProcessHost, "exec"> & {
  exec(command: ShellCommand, options?: HostExecOptions): ReturnType<ProcessHost["exec"]>;
};

/** The process-wide host. Created on first use so importing this module starts no threads. */
export function getProcessHost(): BridgeProcessHost {
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
