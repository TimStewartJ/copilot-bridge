// Runs in a scratch project that has only the packed tarballs installed (npm run packages:verify).
// It proves the published build resolves by name, loads its compiled worker, and starts real processes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostExecError, ProcessHost } from "spawn-offthread";

const errorListeners = () => [process.stdout.listenerCount("error"), process.stderr.listenerCount("error")];
const errorListenersAtStart = errorListeners();
const launches = [];
const host = new ProcessHost({ onLaunch: (launch) => launches.push(launch) });
assert.equal(host.mode, "worker");

const result = await host.execFile(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
assert.deepEqual(result, { stdout: "out", stderr: "err" });

const failure = await host.execFile(process.execPath, ["-e", "process.exit(3)"]).catch((error) => error);
assert.ok(failure instanceof HostExecError);
assert.equal(failure.code, 3);

const echo = "process.stdin.once('data', (chunk) => { process.stdout.write('got:' + chunk); process.exit(0); })";
const child = await host.spawn(process.execPath, ["-e", echo], { stdio: ["pipe", "pipe", "pipe"] });
assert.equal(typeof child.pid, "number");
const output = new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk))));
const exited = new Promise((resolve) => child.once("exit", resolve));
child.stdin.write("hello");
assert.equal(await output, "got:hello");
assert.equal(await exited, 0);

const scratch = mkdtempSync(join(tmpdir(), "spawn-offthread-smoke-"));
const tree = join(scratch, "tree");
mkdirSync(join(tree, "a", "b"), { recursive: true });
writeFileSync(join(tree, "a", "b", "file.txt"), "x");
await host.removeTree(tree);
assert.equal(existsSync(tree), false);
rmSync(scratch, { recursive: true, force: true });

assert.equal(launches.length, 3);
assert.ok(launches.every((launch) => launch.createMs >= 0 && launch.queuedMs >= 0));
// Its worker threads are running, and the host has put no listener on this program's streams.
assert.deepEqual(errorListeners(), errorListenersAtStart);
await host.shutdown();

// A program that logs to a file survives a write the operating system refuses. Before 0.1.1 the
// pipe Node puts between a worker thread and process.stdout made that an unhandled 'error'.
// The script sits beside this file so that it resolves the package by name the same way.
const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "spawn-offthread.refuse-write.cjs");
const program = join(here, "spawn-offthread.failed-write.mjs");
const logFile = join(here, "spawn-offthread.failed-write.log");
// Loaded with --require: Node takes its reference to fs.writeSync when stdout is first used.
writeFileSync(preload, [
  'const fs = require("node:fs");',
  "const writeSync = fs.writeSync;",
  "fs.writeSync = function (fd, ...rest) {",
  '  if (fd === 1 && String(rest[0]).includes("REFUSE-THIS-LINE")) {',
  '    throw Object.assign(new Error("UNKNOWN: unknown error, write"), { errno: -4094, code: "UNKNOWN", syscall: "write" });',
  "  }",
  "  return writeSync.call(this, fd, ...rest);",
  "};",
].join("\n"));
writeFileSync(program, [
  'import { ProcessHost } from "spawn-offthread";',
  "const host = new ProcessHost();",
  'await host.execFile(process.execPath, ["-e", ""]);',
  'console.log("before");',
  'console.log("REFUSE-THIS-LINE");',
  "await new Promise((resolve) => setImmediate(resolve));",
  'console.log("after");',
  "await host.shutdown();",
].join("\n"));
const logFd = openSync(logFile, "w");
let run;
try {
  run = spawnSync(process.execPath, ["--require", preload, program], { stdio: ["ignore", logFd, "pipe"], encoding: "utf8" });
} finally {
  closeSync(logFd);
}
assert.equal(run.status, 0, run.stderr);
assert.equal(readFileSync(logFile, "utf8"), "before\nafter\n");
for (const file of [preload, program, logFile]) rmSync(file, { force: true });

console.log(`spawn-offthread smoke passed: ${launches.length} processes created off the calling thread`);