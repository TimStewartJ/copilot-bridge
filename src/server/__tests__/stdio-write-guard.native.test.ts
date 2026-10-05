import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDir } from "./helpers.js";

// A process of its own, logging to files the way the Bridge's processes do, in which one write to
// stdout is refused. This is the exit of 2026-10-05: with a worker thread in the process, Node no
// longer drops a line it cannot write, and the error ended the server.

// Loaded with --require, before anything touches process.stdout: Node's file stream takes its
// reference to fs.writeSync when stdout is first used.
const REFUSE_MARKED_STDOUT_WRITES = [
  'const fs = require("node:fs");',
  "const writeSync = fs.writeSync;",
  "fs.writeSync = function (fd, ...rest) {",
  '  if (fd === 1 && String(rest[0]).includes("REFUSE-THIS-LINE")) {',
  '    throw Object.assign(new Error("UNKNOWN: unknown error, write"), { errno: -4094, code: "UNKNOWN", syscall: "write" });',
  "  }",
  "  return writeSync.call(this, fd, ...rest);",
  "};",
].join("\n");

function program(installGuard: boolean): string {
  return [
    'import { Worker } from "node:worker_threads";',
    ...(installGuard
      ? [
          "const { installStdioWriteGuard } = await import(process.argv[2]);",
          "const guard = installStdioWriteGuard();",
        ]
      : []),
    // As in the server: a worker thread, whose output Node pipes into process.stdout.
    'const worker = new Worker("setInterval(() => {}, 60000);", { eval: true });',
    'await new Promise((resolve) => worker.once("online", resolve));',
    'console.log("before");',
    'console.log("REFUSE-THIS-LINE");',
    // An unhandled 'error' event is thrown before the next macrotask.
    "await new Promise((resolve) => setImmediate(resolve));",
    'console.log("after");',
    ...(installGuard ? ["guard.reportNow();"] : []),
    "await worker.terminate();",
  ].join("\n");
}

async function run(installGuard: boolean): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = makeTestDir("stdio-write-guard");
  const preloadPath = join(dir, "refuse-marked-writes.cjs");
  const programPath = join(dir, "program.mjs");
  const stdoutPath = join(dir, "stdout.log");
  const stderrPath = join(dir, "stderr.log");
  writeFileSync(preloadPath, REFUSE_MARKED_STDOUT_WRITES);
  writeFileSync(programPath, program(installGuard));
  // The launcher and the job runner run under tsx too, and its loader thread is one more worker.
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const guardUrl = new URL("../stdio-write-guard.ts", import.meta.url).href;
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let code: number | null;
  try {
    const child = spawn(
      process.execPath,
      ["--require", preloadPath, "--import", tsxLoader, programPath, guardUrl],
      { stdio: ["ignore", stdoutFd, stderrFd], windowsHide: true },
    );
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return { code, stdout: readFileSync(stdoutPath, "utf8"), stderr: readFileSync(stderrPath, "utf8") };
}

describe("a refused write to stdout in a process with a worker thread", () => {
  it("ends a process that has no guard, which is what the guard is for", async () => {
    const result = await run(false);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unhandled 'error' event");
    expect(result.stdout).toBe("before\n");
  });

  it("leaves a guarded process running, and the loss is reported in both logs", async () => {
    const result = await run(true);

    expect(result.code, result.stderr).toBe(0);
    const [before, after, report, rest] = result.stdout.split("\n");
    expect([before, after, rest]).toEqual(["before", "after", ""]);
    expect(report).toMatch(/\[stdio\] 1 write to stdout failed .* its output is lost \(program\.mjs, pid \d+; 1 since it started\)\. Last error: UNKNOWN: unknown error, write\./);
    expect(result.stderr).toContain(report);
  });
});
