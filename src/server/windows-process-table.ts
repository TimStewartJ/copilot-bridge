import { Worker } from "node:worker_threads";
import { isRecord } from "../shared/is-record.js";
import { resolveWorkerEntry } from "./process-host.js";
import type { WindowsProcessTableEntry } from "./windows-process-table-worker.js";

export interface WindowsSnapshotWorker {
  postMessage(message: { id: number }): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

const WORKER_FLAG = "bridgeWindowsProcessTableWorker";
interface PendingSnapshot {
  resolve: (entries: WindowsProcessTableEntry[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function startWorker(): WindowsSnapshotWorker {
  const { entry, execArgv } = resolveWorkerEntry("windows-process-table-worker");
  return new Worker(entry, { workerData: { [WORKER_FLAG]: true }, ...(execArgv ? { execArgv } : {}) });
}

function snapshotEntries(value: unknown): WindowsProcessTableEntry[] {
  if (!Array.isArray(value)) throw new Error("Windows process snapshot worker returned no entries");
  const pids = new Set<number>();
  return value.map((entry: unknown): WindowsProcessTableEntry => {
    if (!isRecord(entry) || typeof entry.pid !== "number" || !Number.isSafeInteger(entry.pid) || entry.pid <= 0
      || typeof entry.ppid !== "number" || !Number.isSafeInteger(entry.ppid) || entry.ppid < 0
      || typeof entry.startMarker !== "string" || (entry.startMarker !== "" && !/^\d+$/.test(entry.startMarker))
      || (entry.identityError !== undefined && typeof entry.identityError !== "string")
      || pids.has(entry.pid)) {
      throw new Error("Windows process snapshot worker returned an invalid or duplicate identity");
    }
    pids.add(entry.pid);
    return { pid: entry.pid, ppid: entry.ppid, startMarker: entry.startMarker,
      ...(typeof entry.identityError === "string" ? { identityError: entry.identityError } : {}) };
  });
}

export class WindowsProcessTableReader {
  private worker: WindowsSnapshotWorker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, PendingSnapshot>();

  constructor(private readonly options: { createWorker?: () => WindowsSnapshotWorker } = {}) {}

  read(timeoutMs: number): Promise<WindowsProcessTableEntry[]> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Windows process snapshot deadline exceeded"));
    return new Promise((resolve, reject) => {
      let worker: WindowsSnapshotWorker;
      try {
        worker = this.connect();
      } catch (error) {
        reject(error);
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.lose(worker, new Error(`Native Windows process snapshot timed out after ${timeoutMs}ms`));
        void worker.terminate().catch((error: unknown) => console.warn(`[windows-process-table] Worker termination failed: ${error instanceof Error ? error.message : String(error)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.ref();
      try {
        worker.postMessage({ id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }

  async shutdown(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.lose(worker, new Error("Windows process snapshot reader shut down"));
    await worker.terminate();
  }

  private connect(): WindowsSnapshotWorker {
    if (this.worker) return this.worker;
    const worker = (this.options.createWorker ?? startWorker)();
    this.worker = worker;
    worker.unref();
    worker.on("message", (reply: unknown) => {
      if (this.worker !== worker) return;
      if (!isRecord(reply) || typeof reply.id !== "number" || !Number.isSafeInteger(reply.id) || reply.id <= 0) {
        this.lose(worker, new Error("Windows process snapshot worker sent a malformed reply"));
        void worker.terminate().catch((error: unknown) => console.warn(`[windows-process-table] Worker termination failed: ${String(error)}`));
        return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (this.pending.size === 0) worker.unref();
      try {
        if (typeof reply.error === "string") throw new Error(reply.error);
        pending.resolve(snapshotEntries(reply.entries));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.on("error", (error: Error) => this.lose(worker, error));
    worker.on("exit", (code: number) => this.lose(worker, new Error(`Windows process snapshot worker exited with code ${code}`)));
    return worker;
  }

  private lose(worker: WindowsSnapshotWorker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    worker.unref();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let shared = new WindowsProcessTableReader();
export function readNativeWindowsProcessTable(timeoutMs: number): Promise<WindowsProcessTableEntry[]> {
  return shared.read(timeoutMs);
}

export async function resetWindowsProcessTableForTests(): Promise<void> {
  await shared.shutdown();
  shared = new WindowsProcessTableReader();
}
