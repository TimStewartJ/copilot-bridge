import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface WorkerEntry {
  /** Absolute path of the worker module, ready for `new Worker(entry)`. */
  entry: string;
  /** Set when the worker has to be loaded from TypeScript source; pass it to `new Worker`. */
  execArgv?: string[];
}

/** From .ts add tsx (hooks miss workers); never re-pass execArgv (Worker rejects its flags). */
export function resolveWorkerEntry(name: string, moduleUrl: string): WorkerEntry {
  const isSource = moduleUrl.endsWith(".ts");
  const entry = join(dirname(fileURLToPath(moduleUrl)), `${name}.${isSource ? "ts" : "js"}`);
  if (isSource) {
    return { entry, execArgv: ["--import", pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href] };
  }
  return { entry };
}
