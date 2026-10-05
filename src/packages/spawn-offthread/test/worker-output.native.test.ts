import { Writable } from "node:stream";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { ProcessHost } from "../src/index.js";
import { relayWorkerOutput } from "../src/worker-output.js";

// Real worker threads. The *.native.test.ts name puts this file in the native project of the
// Copilot Bridge repository. test/smoke.mjs covers the same ground in a process of its own, where
// stdout is a file and a write to it is refused.

function errorListeners(): number[] {
  return [process.stdout.listenerCount("error"), process.stderr.listenerCount("error")];
}

/** Collects what is written to it, refuses a chunk that contains "REFUSED", and tells a waiting test what has arrived. */
function collector() {
  let text = "";
  let attempts = 0;
  const waiting: Array<{ ready: () => boolean; resolve: () => void }> = [];
  const stream = new Writable({
    // Like process.stdout, which goes on after a write that failed.
    autoDestroy: false,
    write(chunk, _encoding, callback) {
      attempts += 1;
      const refused = String(chunk).includes("REFUSED");
      if (!refused) text += String(chunk);
      callback(refused ? new Error("write refused") : null);
      for (const entry of waiting.splice(0)) {
        if (entry.ready()) entry.resolve();
        else waiting.push(entry);
      }
    },
  });
  const until = (ready: () => boolean) => new Promise<void>((resolve) => {
    if (ready()) resolve();
    else waiting.push({ ready, resolve });
  });
  return {
    stream,
    text: () => text,
    has: (needle: string) => until(() => text.includes(needle)),
    attempted: (count: number) => until(() => attempts >= count),
  };
}

describe("worker thread output", () => {
  it("leaves no listener on the process's stdout and stderr once the host has worker threads", async () => {
    const before = errorListeners();
    const host = new ProcessHost({ mode: "worker" });
    try {
      await host.execFile(process.execPath, ["-e", ""]);
      const child = await host.spawn(process.execPath, ["-e", ""]);
      await new Promise((resolve) => child.once("close", resolve));
      expect(errorListeners()).toEqual(before);
    } finally {
      await host.shutdown();
    }
  });

  it("passes a worker thread's stdout and stderr on", async () => {
    const before = errorListeners();
    const out = collector();
    const err = collector();
    const worker = new Worker("console.log('to stdout'); console.error('to stderr'); setInterval(() => {}, 60000);", { eval: true });
    try {
      relayWorkerOutput(worker, { stdout: out.stream, stderr: err.stream });
      expect(errorListeners()).toEqual(before);
      await Promise.all([out.has("to stdout\n"), err.has("to stderr\n")]);
      expect(out.text()).toBe("to stdout\n");
      expect(err.text()).toBe("to stderr\n");
    } finally {
      await worker.terminate();
    }
  });

  it("drops a chunk that cannot be written, and leaves no listener behind", async () => {
    const out = collector();
    const worker = new Worker("process.stdout.write('REFUSED'); setInterval(() => {}, 60000);", { eval: true });
    try {
      relayWorkerOutput(worker, { stdout: out.stream, stderr: collector().stream });
      await out.attempted(1);
      // The stream reports the failure to the write first and emits 'error' after it. Nothing
      // listened for that event; had it been thrown, this test would have failed with it.
      await new Promise((resolve) => setImmediate(resolve));
      expect(out.text()).toBe("");
      expect(out.stream.listenerCount("error")).toBe(0);
    } finally {
      await worker.terminate();
    }
  });

  it("leaves a failed write to the program's own listener when it has one", async () => {
    const out = collector();
    const seen = new Promise<Error>((resolve) => out.stream.on("error", resolve));
    const worker = new Worker("process.stdout.write('REFUSED'); setInterval(() => {}, 60000);", { eval: true });
    try {
      relayWorkerOutput(worker, { stdout: out.stream, stderr: collector().stream });
      expect((await seen).message).toBe("write refused");
      expect(out.stream.listenerCount("error")).toBe(1);
    } finally {
      await worker.terminate();
    }
  });
});
