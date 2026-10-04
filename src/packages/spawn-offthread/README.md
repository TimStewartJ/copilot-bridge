# spawn-offthread

`child_process` for Node.js that creates processes on worker threads, so your event loop keeps
running while the operating system starts them.

```ts
import { ProcessHost } from "spawn-offthread";

const host = new ProcessHost();

// Run a command to completion, like util.promisify(execFile).
const { stdout } = await host.execFile("git", ["status", "--short"], { timeout: 10_000 });

// Start a long-lived child, like spawn(). It resolves once the process exists.
const child = await host.spawn("node", ["server.js"], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.on("exit", (code) => console.log(`server exited with ${code}`));
```

## The problem

`spawn`, `execFile`, `exec` and `fork` are asynchronous once the child is running. Creating it is
not: that is one synchronous system call on the thread that asked (`CreateProcessW` on Windows,
`fork`/`exec` or `posix_spawn` elsewhere). Until it returns, that thread's event loop serves
nothing: no HTTP request, no timer, no health probe.

Usually the call takes a few milliseconds. It takes much longer when an antivirus scans the
binary, when the machine is short of CPU or disk, or when the parent process is large.
[nodejs/node#14917](https://github.com/nodejs/node/issues/14917), "spawn() is not asynchronous,
blocks event loop for 2-3 seconds", was reported in 2017, closed without a fix, and was still
collecting reports in 2025.

This package was written for a server that froze for seconds at a time on a busy Windows machine.
Measured there, with the same launches made both ways in the same seconds:

| | Creating a process took | Event-loop lag on the calling thread |
|---|---|---|
| `spawn()` on the main thread | up to 7.25 s | up to 7.2 s |
| the same launches through a process host | up to 9.15 s, on a worker thread | 0.4 s at most, 67 ms at the 95th percentile |

Processes are not created any faster. The wait moves to a thread that has nothing else to do.

It also shows without an overloaded machine.
[`bench/event-loop.mjs`](https://github.com/TimStewartJ/copilot-bridge/blob/master/src/packages/spawn-offthread/bench/event-loop.mjs)
starts 200 `node -e ""` processes, 8 at a time, each way. On an otherwise idle 12th-generation
Core i7 desktop with Windows 11 and Node 24:

| | `node:child_process` | `spawn-offthread` |
|---|---|---|
| Time the calling thread was blocked inside the start calls | 4.3 s | 0.17 s |
| Longest single block | 56 ms | 12 ms |
| Event-loop delay, median and 99th percentile | 91 ms and 234 ms | 10 ms and 29 ms |
| Time to finish all 200 | 4.4 s | 4.6 s |

Those numbers are from one machine and one run. Creating a process is much cheaper on Linux, so
the effect there is smaller. The same benchmark on an Ubuntu 24.04 machine (Core i7-1185G7,
Node 24) blocked the calling thread for 0.65 to 0.82 s with `node:child_process` and for 0.04 to
0.05 s with this package, and the 99th percentile of event-loop delay fell from between 9 and
17 ms to under 5 ms.

Run the benchmark where your code runs before deciding you need this. It is one file: save it
into a project that has this package installed and run `node event-loop.mjs`.

## Install

```sh
npm install spawn-offthread
```

Node.js 22 or newer. ESM only. No dependencies.

## API

### `new ProcessHost(options?)`

| Option | Default | Meaning |
|---|---|---|
| `mode` | `"worker"` | `"inline"` creates processes on the calling thread with the same API. See [Testing](#testing). |
| `maxPoolWorkers` | `4` | Most worker threads that `execFile` and `exec` share. |
| `onLaunch` | none | Called once per process with `{ kind, file, createMs, queuedMs }`: how long the operating system took to create it, and how long the request waited for a free worker. |
| `onUnhandledChildError` | console warning | Called with `(error, pid)` when a child reports an error that nothing listens for. |

Creating a host starts no threads. They start on first use, and idle ones do not keep the process alive.

### `host.execFile(file, args?, options?)` and `host.exec(command, options?)`

Run a command to completion and resolve with `{ stdout, stderr }` as strings. They reject with a
`HostExecError`, which has the fields of the error Node's own `execFile` rejects with (`code`,
`signal`, `killed`, `cmd`, `stdout`, `stderr`) and `timedOut`.

Options: `cwd`, `env`, `timeout`, `maxBuffer`, `shell`, `windowsHide`, `windowsVerbatimArguments`,
`killSignal`, and:

- `completeWhen: "stdout-json"` resolves as soon as stdout holds one complete JSON value and then
  kills the child. Some command-line clients print their result and then take seconds to exit.

`timeout` is applied twice. The worker applies it to the running process, exactly as Node does.
The host also enforces it on the calling thread, one second later, so a command whose process
cannot even be created in time fails with `timedOut: true` instead of holding its caller for the
length of the stall. A command still waiting for a free worker at its deadline is dropped and never
starts. One whose process was being created is killed as soon as its worker is free again.

### `host.spawn(file, args?, options?)` and `host.fork(modulePath, args?, options?)`

Start a long-lived child and resolve with a `HostChild` once the process exists. A process that
cannot be created still resolves, with `pid` undefined and an `"error"` event followed by
`"close"`, which is how `child_process.spawn` reports it.

A `HostChild` has the part of `ChildProcess` most code uses: `pid`, `stdin`, `stdout`, `stderr`,
`exitCode`, `signalCode`, `killed`, `connected`, `send()`, `kill()`, `disconnect()`, `ref()`,
`unref()`, and the `"message"`, `"disconnect"`, `"error"`, `"exit"` and `"close"` events.

Options: `cwd`, `env`, `shell`, `windowsHide`, `windowsVerbatimArguments`, `detached`, `stdio`,
`serialization`, and `execArgv` for `fork`.

### `host.removeTree(path)`

Deletes a file or directory tree on a worker thread. A path that is already gone is not an error,
and a link inside the tree is removed, not followed. It is here because it is the same kind of
call: a synchronous delete holds its thread for the whole tree, and the asynchronous one crowds the
thread pool that every other file read shares.

It rejects when the tree cannot be deleted. On Windows that includes a tree another process is
using, which fails with `EPERM`. The delete asks Node's `fs.rmSync` to retry, but Node only waits
for a tree in use from the release that contains
[nodejs/node#64698](https://github.com/nodejs/node/pull/64698); Node 24.14 fails at once. Retry the
call yourself if that can happen.

### `host.shutdown()`

Stops every worker thread and rejects commands that are still running. Children of stopped workers
are not killed or waited for, so stop the ones you care about first.

## How it works

- `execFile` and `exec` share a small pool of worker threads. A worker that is in the middle of
  creating a process is never handed another request, because it may be blocked. Requests that find
  no free worker wait in a queue on the calling thread, which costs it nothing.
- `spawn` and `fork` give each child its own worker thread, so relaying one child's output and
  messages is never stuck behind another slow process creation. The thread ends when the child closes.
- A worker thread keeps the copy of `process.env` it started with. `child_process` reads the live
  one, so the host reads `process.env` on the calling thread, at call time, whenever you pass no `env`.

Each call costs the calling thread one message to a worker and one back, plus that copy of the
environment: about 0.8 ms per launch in the benchmark above.

## Differences from `child_process`

- `spawn` and `fork` return a promise.
- Standard streams are `"pipe"` or `"ignore"`, with `"ipc"` allowed as a fourth entry. `"inherit"`,
  file descriptors and stream objects cannot cross a thread boundary. An option the host cannot
  honour throws a `TypeError`; it is never silently ignored.
- `exec` and `execFile` always return strings, and take no `signal`.
- `send()` takes a message and a callback. Sending handles is not supported. A message crosses to
  the child's thread by structured clone before it is serialized for the child, so it has to be
  cloneable even with the default JSON serialization: `send()` throws for one that is not.
- There is no backpressure across the thread boundary: writes to `stdin` complete immediately, and
  output you do not read is buffered in memory.
- An `"error"` event that nothing listens for goes to `onUnhandledChildError` instead of being
  thrown, so a missing listener cannot take the process down.
- A `HostChild` has no `"spawn"` event, `stdio` array, `spawnfile` or `spawnargs`.
- `ref()` and `unref()` apply to the child's worker thread.

## Testing

Test suites often mock `node:child_process`. A mock installed on the test's thread is invisible to
a worker thread, so build the host with `mode: "inline"` in tests. The API is the same and
processes are created on the calling thread, through the mocked module.

`mode: "inline"` is also a fallback if worker threads cause trouble in production.

## Limits

- Its tests run on Windows, Ubuntu and macOS, with Node.js 22 and 24. Beyond the tests it has been
  used on Windows 11 and Ubuntu 24.04, and not on macOS.
- Every long-lived child holds a worker thread, which costs several megabytes. This suits tens of
  children, not thousands.
- The worker is loaded from a file beside the package's entry point. If you bundle your server,
  keep this package external.

## License

MIT
