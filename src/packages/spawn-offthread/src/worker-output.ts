// Relay by hand: Node's pipe turns a failed stdout write into a crash, and stdout:true blocks exit.

import type { Readable, Writable } from "node:stream";

/** The part of a Worker this module uses. */
export interface WorkerOutput {
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export interface WorkerOutputTargets {
  stdout: Writable;
  stderr: Writable;
}

function ignore(): void {}

/** Writes like console.log: a failed write is dropped unless the program listens for the error. */
function writeDroppingFailures(target: Writable, chunk: Buffer | string): void {
  try {
    target.write(chunk, (error) => {
      // The stream emits the error after this callback. Left without a listener it would be thrown.
      if (error && target.listenerCount("error") === 0) target.once("error", ignore);
    });
  } catch {
    // A stream that throws on write has lost the chunk as surely as one that reports a failure.
  }
}

/** Replaces a new worker's stdout/stderr pipes; call right after `new Worker` without them. */
export function relayWorkerOutput(
  worker: WorkerOutput,
  targets: WorkerOutputTargets = { stdout: process.stdout, stderr: process.stderr },
): void {
  const routes: Array<[Readable, Writable, Writable]> = [
    [worker.stdout, process.stdout, targets.stdout],
    [worker.stderr, process.stderr, targets.stderr],
  ];
  for (const [source, piped, target] of routes) {
    source.unpipe(piped);
    source.on("data", (chunk: Buffer | string) => writeDroppingFailures(target, chunk));
    // Removing the last pipe paused the stream, and adding a listener does not resume it.
    source.resume();
  }
}
