import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface WorkerEntry {
  /** Absolute path of the worker module, ready for `new Worker(entry)`. */
  entry: string;
  /** Set when the worker has to be loaded from TypeScript source; pass it to `new Worker`. */
  execArgv?: string[];
}

/**
 * Locates a worker module that sits beside the module at `moduleUrl` (pass `import.meta.url`).
 * The published build always takes the first path: compiled code loads the .js worker and
 * inherits execArgv. When this package runs from its TypeScript source (tsx, Vitest) the .ts
 * worker is loaded with the tsx loader passed explicitly: loader hooks registered by a tsx parent
 * are not reliably inherited by worker threads. Inherited execArgv is never re-passed, because
 * `new Worker` rejects process-level flags that inheritance silently tolerates.
 */
export function resolveWorkerEntry(name: string, moduleUrl: string): WorkerEntry {
  const isSource = moduleUrl.endsWith(".ts");
  const entry = join(dirname(fileURLToPath(moduleUrl)), `${name}.${isSource ? "ts" : "js"}`);
  if (isSource) {
    return { entry, execArgv: ["--import", pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href] };
  }
  return { entry };
}
