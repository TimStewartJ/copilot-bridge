// Passes a worker thread's stdout and stderr on to the process's own, without Node's pipes.
//
// Node pipes a worker's output into process.stdout and process.stderr, and a pipe listens for
// 'error' on its destination. console.log drops a line it cannot write (a full disk, a closed
// pipe, an operating system short of memory), but only while nothing else listens for 'error' on
// the stream. With a worker's pipe in place, one failed write to the process's stdout became an
// unhandled 'error' event and ended the program.
//
// The streams are left as Node created them, not requested with `stdout: true`: reading a stream
// requested that way keeps the event loop alive until the worker ends, and an idle host must
// never keep its program from exiting.

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

/** Writes the way console.log does: a write that fails is dropped, unless the program listens for the error itself. */
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

/**
 * Replaces the pipes Node put between a new worker thread and the process's stdout and stderr.
 * Call it right after `new Worker(...)`, on a worker created without `stdout` or `stderr`.
 */
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
    // Removing the last pipe paused the stream, and a paused stream stays paused when a listener is added.
    source.resume();
  }
}
