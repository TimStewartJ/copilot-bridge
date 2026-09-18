// Main-thread access to the Copilot CLI's session store (<copilot home>/session-store.db).
//
// Every operation runs in cli-session-store-worker.ts on one long-lived worker thread, in the
// order it was asked for, so an open that an antivirus scan holds for seconds, or a delete waiting
// for the CLI's write lock, never stalls the server's event loop. Callers wait for the answer;
// nothing is cached or timed out, so results mean what they always did. The inline backend
// (tests, BRIDGE_PROCESS_HOST=inline) runs the same function on the calling thread.

import { Worker } from "node:worker_threads";
import { getProcessHost, resolveWorkerEntry, type HostWorker } from "./process-host.js";
import type { CliCatalogRead, CliCatalogReadRequest, CliSessionStoreRequest } from "./cli-session-store-worker.js";

/** Must match CLI_SESSION_STORE_WORKER_FLAG in the worker module, which the main thread never imports in worker mode. */
const WORKER_FLAG = "bridgeCliSessionStoreWorker";

interface Reply {
  id: number;
  value?: unknown;
  error?: string;
}

function startWorkerThread(): HostWorker {
  const { entry, execArgv } = resolveWorkerEntry("cli-session-store-worker");
  return new Worker(entry, { workerData: { [WORKER_FLAG]: true }, ...(execArgv ? { execArgv } : {}) });
}

export class CliSessionStore {
  private worker: HostWorker | undefined;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private nextId = 0;

  constructor(private readonly options: { inline?: boolean; createWorker?: () => HostWorker } = {}) {}

  async run(request: CliSessionStoreRequest): Promise<unknown> {
    if (this.options.inline ?? getProcessHost().mode === "inline") {
      return (await import("./cli-session-store-worker.js")).runCliSessionStoreRequest(request);
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.waiting.set(id, { resolve, reject });
      this.connect().postMessage({ id, request });
    });
  }

  /** Stops the worker thread. Requests still waiting fail; the next request starts a new thread. */
  async shutdown(): Promise<void> {
    const worker = this.worker;
    this.lose(worker, new Error("CLI session store shut down"));
    await worker?.terminate();
  }

  private connect(): HostWorker {
    if (this.worker) return this.worker;
    const worker = (this.options.createWorker ?? startWorkerThread)();
    worker.unref();
    worker.on("message", ({ id, value, error }: Reply) => {
      const waiter = this.waiting.get(id);
      this.waiting.delete(id);
      if (error === undefined) waiter?.resolve(value);
      else waiter?.reject(new Error(error));
    });
    worker.on("error", (error: Error) => this.lose(worker, error));
    worker.on("exit", (code: number) => this.lose(worker, new Error(`CLI session store worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  private lose(worker: HostWorker | undefined, reason: Error): void {
    if (!worker || this.worker !== worker) return;
    this.worker = undefined;
    for (const waiter of this.waiting.values()) waiter.reject(reason);
    this.waiting.clear();
  }
}

let shared = new CliSessionStore();

export function readCliSessionCatalog(request: CliCatalogReadRequest): Promise<CliCatalogRead> {
  return shared.run(request) as Promise<CliCatalogRead>;
}

export async function deleteCliSessionStoreRows(copilotHome: string, sessionId: string): Promise<void> {
  await shared.run({ op: "delete", copilotHome, sessionId });
}

/** Deletes rows of disposable sessions that outlived their session-state directory. Returns their IDs. */
export function sweepLeakedCliSessionStoreRows(opts: {
  copilotHome: string;
  idPrefix: string;
  cutoffTimestampMs: number;
}): Promise<string[]> {
  return shared.run({ op: "sweep", ...opts }) as Promise<string[]>;
}

export async function resetCliSessionStoreForTests(): Promise<void> {
  await shared.shutdown();
  shared = new CliSessionStore();
}
