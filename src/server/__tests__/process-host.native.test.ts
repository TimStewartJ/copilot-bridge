import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import {
  getProcessHost,
  resetProcessHostForTests,
  resolveWorkerEntry,
  setProcessLaunchObserver,
  type ProcessLaunchObservation,
} from "../process-host.js";

afterAll(async () => {
  setProcessLaunchObserver(undefined);
  await resetProcessHostForTests();
});

describe("Bridge process host in the native project", () => {
  it("runs the native project on the production backend", () => {
    // vitest.native.config.ts selects it. Without this, a config change would silently move every
    // native test (process trees, staged backends, runtime fencing) onto the inline backend.
    expect(getProcessHost().mode).toBe("worker");
  });

  it("creates a real process on a worker thread and reports the launch to the observer", async () => {
    const launches: ProcessLaunchObservation[] = [];
    setProcessLaunchObserver((observation) => launches.push(observation));

    const { stdout } = await getProcessHost().execFile(process.execPath, ["-e", "process.stdout.write('ok')"]);

    expect(stdout).toBe("ok");
    expect(launches).toEqual([
      { kind: "exec", file: process.execPath, createMs: expect.any(Number), queuedMs: expect.any(Number) },
    ]);
  });
});

describe("worker entry for hosts from before the move", () => {
  // The launcher and the job runner keep the host they started with. After a deploy that host
  // still starts its worker threads from src/server/process-host-worker.ts, under its old flag.
  it("serves the old path and flag with the unchanged message protocol", async () => {
    const { entry, execArgv } = resolveWorkerEntry("process-host-worker");
    const worker = new Worker(entry, { workerData: { bridgeProcessHostWorker: true }, ...(execArgv ? { execArgv } : {}) });
    try {
      const events: Array<{ type: string; id: number; outcome?: { stdout: string; error?: unknown } }> = [];
      const done = new Promise<void>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("exit", (code) => reject(new Error(`worker exited with code ${code} before answering`)));
        worker.on("message", (event: (typeof events)[number]) => {
          events.push(event);
          if (event.type === "exec-done") resolve();
        });
      });
      worker.postMessage({
        type: "exec",
        id: 7,
        request: { kind: "execFile", file: process.execPath, args: ["-e", "process.stdout.write('served')"], options: {} },
      });
      await done;

      expect(events.map((event) => [event.type, event.id])).toEqual([["exec-created", 7], ["exec-done", 7]]);
      expect(events[1]!.outcome).toMatchObject({ stdout: "served" });
      expect(events[1]!.outcome!.error).toBeUndefined();
    } finally {
      await worker.terminate();
    }
  });
});
