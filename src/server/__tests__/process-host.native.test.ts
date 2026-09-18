import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getProcessHost, HostExecError, ProcessHost } from "../process-host.js";
import { createDirectoryLink } from "../platform.js";
import { makeTestDir } from "./helpers.js";

// Drives real worker threads and real child processes, so it runs in the native project where
// it does not compete with the parallel suites for process creation.
const host = new ProcessHost({ mode: "worker" });
const node = process.execPath;

afterAll(async () => {
  await host.shutdown();
});

describe("ProcessHost on real worker threads", () => {
  it("runs the native project on the production backend", () => {
    // vitest.native.config.ts selects it. Without this, a config change would silently move every
    // native test (process trees, staged backends, runtime fencing) onto the inline backend.
    expect(getProcessHost().mode).toBe("worker");
  });

  it("runs a command to completion and returns both streams", async () => {
    const result = await host.execFile(node, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
    expect(result).toEqual({ stdout: "out", stderr: "err" });
  });

  it("rejects a failing command with its exit code and partial output", async () => {
    const error = await host.execFile(node, ["-e", "process.stdout.write('partial'); process.exit(3)"])
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HostExecError);
    expect(error).toMatchObject({ code: 3, killed: false, stdout: "partial" });
  });

  it("kills a command that outlives its timeout", async () => {
    const error = await host.execFile(node, ["-e", "setTimeout(() => {}, 600000)"], { timeout: 500 })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ killed: true });
  });

  it("reports a missing executable as ENOENT", async () => {
    const error = await host.execFile("bridge-no-such-binary-for-tests", []).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "ENOENT" });
  });

  it("runs a shell command line", async () => {
    const { stdout } = await host.exec("echo process-host-shell");
    expect(stdout.trim()).toBe("process-host-shell");
  });

  it("completes on a full JSON result without waiting for a client that never exits", async () => {
    const script = "process.stdout.write(JSON.stringify({ success: true, data: 1 })); setTimeout(() => {}, 600000)";
    const { stdout } = await host.execFile(node, ["-e", script], { completeWhen: "stdout-json" });
    expect(JSON.parse(stdout)).toEqual({ success: true, data: 1 });
  });

  it("runs many commands at once across the pool", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => host.execFile(node, ["-e", `process.stdout.write(String(${index}))`])),
    );
    expect(results.map((result) => result.stdout)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("forks a child and relays typed-array IPC, output, and termination", async () => {
    const dir = makeTestDir("process-host-fork-");
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, "child.mjs");
    writeFileSync(entry, [
      "console.log('child up');",
      "process.on('message', (message) => {",
      "  process.send({ isInt16: message.pcm instanceof Int16Array, doubled: Int16Array.from(message.pcm, (v) => v * 2) });",
      "});",
      "setTimeout(() => {}, 600000);",
    ].join("\n"));

    const child = await host.fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
    expect(typeof child.pid).toBe("number");
    expect(child.connected).toBe(true);

    const output = new Promise<string>((resolve) => child.stdout!.once("data", (chunk) => resolve(String(chunk).trim())));
    const reply = new Promise<{ isInt16: boolean; doubled: Int16Array }>((resolve) => child.once("message", resolve));
    const sent = new Promise<Error | null>((resolve) => child.send({ pcm: new Int16Array([1, -2, 3]) }, resolve));

    expect(await sent).toBeNull();
    const message = await reply;
    expect(message.isInt16).toBe(true);
    expect([...message.doubled]).toEqual([2, -4, 6]);
    expect(await output).toBe("child up");

    const closed = new Promise<NodeJS.Signals | null>((resolve) => child.once("close", (_code, signal) => resolve(signal)));
    expect(child.kill()).toBe(true);
    expect(await closed).toBe("SIGTERM");
    expect(child.connected).toBe(false);
  });

  it("spawns a child with piped stdin and reports a clean exit", async () => {
    const child = await host.spawn(node, ["-e", "process.stdin.on('data', (d) => { process.stdout.write('got:' + d); process.exit(0); })"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = new Promise<string>((resolve) => child.stdout!.once("data", (chunk) => resolve(String(chunk))));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.stdin!.write("hello");

    expect(await output).toBe("got:hello");
    expect(await exited).toBe(0);
  });

  it("deletes a directory tree, and a path that is already gone", async () => {
    const tree = join(makeTestDir("process-host-remove-"), "worktree");
    mkdirSync(join(tree, "node_modules", "pkg", "lib"), { recursive: true });
    writeFileSync(join(tree, "node_modules", "pkg", "lib", "index.js"), "module.exports = 1;");
    writeFileSync(join(tree, "package.json"), "{}");

    await host.removeTree(tree);
    expect(existsSync(tree)).toBe(false);
    await expect(host.removeTree(tree)).resolves.toBeUndefined();
  });

  it("never follows a directory link out of the tree it deletes", async () => {
    // Older staging worktrees link node_modules to production's. Deleting the worktree must
    // remove the link (a junction on Windows, a symlink elsewhere), never what it points at.
    const root = makeTestDir("process-host-remove-link-");
    const production = join(root, "production", "node_modules");
    const worktree = join(root, "worktree");
    mkdirSync(join(production, "pkg"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(production, "pkg", "index.js"), "precious");
    expect(createDirectoryLink(join(worktree, "node_modules"), production, root)).toMatchObject({ ok: true });
    expect(readFileSync(join(worktree, "node_modules", "pkg", "index.js"), "utf8")).toBe("precious");

    await host.removeTree(worktree);

    expect(existsSync(worktree)).toBe(false);
    expect(readFileSync(join(production, "pkg", "index.js"), "utf8")).toBe("precious");
  });

  it("rejects when the delete fails", async () => {
    await expect(host.removeTree(`bad${String.fromCharCode(0)}path`)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  });

  it("reports a process that cannot be created through the child's error event", async () => {
    const child = await host.spawn("bridge-no-such-binary-for-tests", [], { stdio: ["ignore", "pipe", "pipe"] });
    expect(child.pid).toBeUndefined();
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => child.once("error", resolve));
    expect(error.code).toBe("ENOENT");
  });
});
