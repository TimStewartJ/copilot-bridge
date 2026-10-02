// Runs in a scratch project that has only the packed tarballs installed (npm run packages:verify).
// It proves the published build resolves by name, loads its compiled worker, and starts real processes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostExecError, ProcessHost } from "spawn-offthread";

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
await host.shutdown();
console.log(`spawn-offthread smoke passed: ${launches.length} processes created off the calling thread`);
