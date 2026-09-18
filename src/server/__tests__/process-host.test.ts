import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostExecError, ProcessHost, type HostWorker, type ProcessLaunchObservation } from "../process-host.js";
import type { HostEvent, HostRequest } from "../process-host-protocol.js";
import { makeTestDir } from "./helpers.js";

/** A scripted worker thread: records what the host sends and replies only when the test says so. */
class ScriptedWorker extends EventEmitter {
  readonly requests: HostRequest[] = [];
  referenced = true;
  terminated = false;

  postMessage(request: HostRequest): void {
    this.requests.push(request);
  }
  ref(): void {
    this.referenced = true;
  }
  unref(): void {
    this.referenced = false;
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  reply(event: HostEvent): void {
    this.emit("message", event);
  }
  execRequests(): Array<Extract<HostRequest, { type: "exec" }>> {
    return this.requests.filter((request): request is Extract<HostRequest, { type: "exec" }> => request.type === "exec");
  }
}

function createHost(options: { maxPoolWorkers?: number } = {}) {
  const workers: ScriptedWorker[] = [];
  const launches: ProcessLaunchObservation[] = [];
  const host = new ProcessHost({
    mode: "worker",
    maxPoolWorkers: options.maxPoolWorkers,
    onLaunch: (observation) => launches.push(observation),
    createWorker: () => {
      const worker = new ScriptedWorker();
      workers.push(worker);
      return worker as unknown as HostWorker;
    },
  });
  return { host, workers, launches };
}

const done = (id: number, stdout = "") => ({ type: "exec-done", id, outcome: { stdout, stderr: "", createMs: 1 } }) as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("ProcessHost exec scheduling", () => {
  it("never gives a second process to a worker that is still creating one", async () => {
    const { host, workers } = createHost({ maxPoolWorkers: 2 });

    const first = host.execFile("git", ["status"]);
    const second = host.execFile("git", ["log"]);
    const third = host.execFile("git", ["diff"]);

    // Two workers, each blocked creating one process. The third request waits on the calling
    // thread instead of queueing behind a creation that may take tens of seconds.
    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.execRequests().length)).toEqual([1, 1]);

    const firstId = workers[0]!.execRequests()[0]!.id;
    workers[0]!.reply({ type: "exec-created", id: firstId, createMs: 12 });
    expect(workers[0]!.execRequests()).toHaveLength(2);

    workers[0]!.reply(done(firstId, "one"));
    workers[1]!.reply(done(workers[1]!.execRequests()[0]!.id, "two"));
    workers[0]!.reply(done(workers[0]!.execRequests()[1]!.id, "three"));
    expect((await Promise.all([first, second, third])).map((result) => result.stdout)).toEqual(["one", "two", "three"]);
  });

  it("reports how long creation took and how long the request waited for a free worker", async () => {
    const { host, workers, launches } = createHost({ maxPoolWorkers: 1 });
    const run = host.execFile("git", ["status"]);
    const id = workers[0]!.execRequests()[0]!.id;

    workers[0]!.reply({ type: "exec-created", id, createMs: 48_000 });
    workers[0]!.reply(done(id));
    await run;

    expect(launches).toEqual([{ kind: "exec", file: "git", createMs: 48_000, queuedMs: expect.any(Number) }]);
  });

  it("keeps the process alive only while a command is in flight", async () => {
    const { host, workers } = createHost();
    const run = host.execFile("git", ["status"]);
    expect(workers[0]!.referenced).toBe(true);

    workers[0]!.reply(done(workers[0]!.execRequests()[0]!.id));
    await run;
    expect(workers[0]!.referenced).toBe(false);
  });

  it("rejects with the same error shape as child_process.execFile", async () => {
    const { host, workers } = createHost();
    const run = host.execFile("git", ["status"]);
    workers[0]!.reply({
      type: "exec-done",
      id: workers[0]!.execRequests()[0]!.id,
      outcome: {
        stdout: "partial",
        stderr: "fatal: not a git repository",
        createMs: 1,
        error: { message: "Command failed: git status", code: 128, killed: false, signal: null, cmd: "git status" },
      },
    });

    const error = await run.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HostExecError);
    expect(error).toMatchObject({
      code: 128,
      killed: false,
      stdout: "partial",
      stderr: "fatal: not a git repository",
      cmd: "git status",
      timedOut: false,
    });
  });
});

describe("ProcessHost environment", () => {
  it("resolves an omitted env on the calling thread at call time, and passes an explicit env through", async () => {
    const { host, workers } = createHost({ maxPoolWorkers: 1 });
    const envOf = (index: number) => workers[0]!.execRequests()[index]!.request.options.env;
    const finish = (index: number) => {
      const { id } = workers[0]!.execRequests()[index]!;
      workers[0]!.reply({ type: "exec-created", id, createMs: 1 });
      workers[0]!.reply(done(id));
    };

    vi.stubEnv("BRIDGE_HOST_ENV_PROBE", "before");
    const first = host.execFile("git", ["status"]);
    expect(envOf(0)).toMatchObject({ BRIDGE_HOST_ENV_PROBE: "before" });
    finish(0);
    await first;

    // The same long-lived worker must see a value that changed after it started.
    vi.stubEnv("BRIDGE_HOST_ENV_PROBE", "after");
    const second = host.execFile("git", ["status"]);
    expect(envOf(1)).toMatchObject({ BRIDGE_HOST_ENV_PROBE: "after" });
    finish(1);
    await second;

    const third = host.execFile("git", ["status"], { env: { ONLY: "this" } });
    expect(envOf(2)).toEqual({ ONLY: "this" });
    finish(2);
    await third;

    void host.spawn("node", ["server.js"], { stdio: ["ignore", "pipe", "pipe"] });
    const spawnRequest = workers[1]!.requests[0] as Extract<HostRequest, { type: "spawn" }>;
    expect(spawnRequest.options.env).toMatchObject({ BRIDGE_HOST_ENV_PROBE: "after" });
  });
});

describe("ProcessHost deadlines", () => {
  it("fails a command on time even though its process is still being created", async () => {
    vi.useFakeTimers();
    const { host, workers } = createHost({ maxPoolWorkers: 1 });
    const run = host.execFile("taskkill", ["/PID", "1"], { timeout: 5_000 });
    const failure = run.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(await failure).toMatchObject({ killed: true, signal: "SIGTERM", code: null, timedOut: true });
    expect(workers[0]!.requests.at(-1)).toEqual({ type: "cancel", id: workers[0]!.execRequests()[0]!.id });
  });

  it("drops a command that expired while waiting so it never starts late", async () => {
    vi.useFakeTimers();
    const { host, workers } = createHost({ maxPoolWorkers: 1 });
    const blocking = host.execFile("git", ["fetch"]);
    const waiting = host.execFile("git", ["status"], { timeout: 1_000 }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await waiting).toMatchObject({ timedOut: true });
    expect(String((await waiting as Error).message)).toContain("waiting for a free process-host worker");

    const blockingId = workers[0]!.execRequests()[0]!.id;
    workers[0]!.reply({ type: "exec-created", id: blockingId, createMs: 1_500 });
    workers[0]!.reply(done(blockingId));
    await blocking;
    expect(workers[0]!.execRequests()).toHaveLength(1);
  });

  it("ignores a late result for a command that already timed out", async () => {
    vi.useFakeTimers();
    const { host, workers } = createHost();
    const failure = host.execFile("git", ["status"], { timeout: 1_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    await failure;

    expect(() => workers[0]!.reply(done(workers[0]!.execRequests()[0]!.id, "late"))).not.toThrow();
  });
});

describe("ProcessHost worker loss", () => {
  it("fails in-flight commands and runs waiting ones on a replacement worker", async () => {
    const { host, workers } = createHost({ maxPoolWorkers: 1 });
    const inFlight = host.execFile("git", ["status"]).catch((error: unknown) => error);
    const waiting = host.execFile("git", ["log"]);

    workers[0]!.emit("error", new Error("out of memory"));

    expect(String((await inFlight as Error).message)).toContain("Process host worker failed: out of memory");
    expect(workers).toHaveLength(2);
    workers[1]!.reply(done(workers[1]!.execRequests()[0]!.id, "recovered"));
    expect((await waiting).stdout).toBe("recovered");
  });
});

describe("ProcessHost removeTree", () => {
  it("deletes on a dedicated worker thread, never on the calling thread", async () => {
    const { host, workers } = createHost();
    const tree = makeTestDir("process-host-remove-");

    const removing = host.removeTree(tree);
    const request = workers[0]!.requests[0] as Extract<HostRequest, { type: "remove-tree" }>;
    expect(request).toMatchObject({ type: "remove-tree", path: tree });
    workers[0]!.reply({ type: "tree-removed", id: request.id });

    await expect(removing).resolves.toBeUndefined();
    // The scripted worker deleted nothing, so a missing tree would mean the calling thread did.
    expect(existsSync(tree)).toBe(true);
    expect(workers[0]!.terminated).toBe(true);

    // A delete can hold its thread for minutes, so commands never share a worker with it.
    void host.execFile("git", ["status"]);
    expect(workers).toHaveLength(2);

    // Nothing to delete: no worker thread is started for it.
    await host.removeTree(join(tree, "missing"));
    expect(workers).toHaveLength(2);
  });

  it("rejects with the file system error, or when its worker is lost", async () => {
    const { host, workers } = createHost();
    const locked = host.removeTree(makeTestDir("process-host-locked-")).catch((error: unknown) => error);
    const request = workers[0]!.requests[0] as Extract<HostRequest, { type: "remove-tree" }>;
    workers[0]!.reply({ type: "tree-removed", id: request.id, error: { message: "EPERM: operation not permitted", code: "EPERM" } });
    expect(await locked).toMatchObject({ code: "EPERM" });

    const lost = host.removeTree(makeTestDir("process-host-lost-")).catch((error: unknown) => error);
    workers[1]!.emit("exit", 1);
    expect(String((await lost as Error).message)).toContain("Process host worker exited with code 1");
  });
});

describe("ProcessHost spawn", () => {
  const spawnOptions = { stdio: ["pipe", "pipe", "pipe", "ipc"] as const, windowsHide: true };

  it("gives every long-lived child its own worker and relays its streams, IPC, and exit", async () => {
    const { host, workers, launches } = createHost();
    const starting = host.spawn("node", ["server.js"], { ...spawnOptions, stdio: [...spawnOptions.stdio] });
    const worker = workers[0]!;
    const request = worker.requests[0] as Extract<HostRequest, { type: "spawn" }>;
    expect(request.options).toMatchObject({ stdin: "pipe", stdout: "pipe", stderr: "pipe", ipc: true, mode: "spawn" });

    worker.reply({ type: "spawned", id: request.id, pid: 4321, createMs: 9 });
    const child = await starting;
    expect(child.pid).toBe(4321);
    expect(child.connected).toBe(true);
    expect(launches).toEqual([{ kind: "spawn", file: "node", createMs: 9, queuedMs: 0 }]);

    const output: string[] = [];
    const messages: unknown[] = [];
    child.stdout!.on("data", (chunk) => output.push(String(chunk)));
    child.on("message", (message) => messages.push(message));
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("close", (code, signal) => resolve([code, signal]));
    });

    worker.reply({ type: "stdout", id: request.id, chunk: Buffer.from("ready\n") });
    worker.reply({ type: "message", id: request.id, message: { type: "ready", port: 5000 } });
    child.stdin!.write("go\n");
    const sent = new Promise<Error | null>((resolve) => child.send({ type: "ping" }, resolve));
    const sendRequest = worker.requests.find((entry) => entry.type === "send") as Extract<HostRequest, { type: "send" }>;
    worker.reply({ type: "sent", id: request.id, seq: sendRequest.seq });
    expect(await sent).toBeNull();

    expect(child.kill("SIGTERM")).toBe(true);
    worker.reply({ type: "exit", id: request.id, code: null, signal: "SIGTERM" });
    worker.reply({ type: "close", id: request.id, code: null, signal: "SIGTERM" });

    expect(await closed).toEqual([null, "SIGTERM"]);
    expect(output).toEqual(["ready\n"]);
    expect(messages).toEqual([{ type: "ready", port: 5000 }]);
    expect(worker.requests.map((entry) => entry.type)).toEqual(["spawn", "stdin", "send", "kill"]);
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.connected).toBe(false);
    expect(worker.terminated).toBe(true);

    const second = host.spawn("node", ["other.js"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ type: "spawned", id: (workers[1]!.requests[0] as { id: number }).id, pid: 99, createMs: 1 });
    await second;
  });

  it("reports a process that cannot be created the way child_process.spawn does", async () => {
    const { host, workers } = createHost();
    const starting = host.spawn("missing-binary", [], { stdio: ["ignore", "pipe", "pipe"] });
    const request = workers[0]!.requests[0] as Extract<HostRequest, { type: "spawn" }>;
    workers[0]!.reply({
      type: "error",
      id: request.id,
      createMs: 3,
      error: { message: "spawn missing-binary ENOENT", code: "ENOENT", syscall: "spawn missing-binary" },
    });

    const child = await starting;
    expect(child.pid).toBeUndefined();
    const events: string[] = [];
    const failure = new Promise<NodeJS.ErrnoException>((resolve) => child.once("error", (error) => {
      events.push("error");
      resolve(error);
    }));
    const closed = new Promise<void>((resolve) => child.once("close", () => {
      events.push("close");
      resolve();
    }));

    expect((await failure).code).toBe("ENOENT");
    await closed;
    expect(events).toEqual(["error", "close"]);
    expect(child.kill()).toBe(false);
  });

  it("surfaces a lost worker as the child's error and close", async () => {
    const { host, workers } = createHost();
    const starting = host.spawn("node", ["server.js"], { stdio: ["ignore", "pipe", "pipe"] });
    const request = workers[0]!.requests[0] as Extract<HostRequest, { type: "spawn" }>;
    // A PID that cannot exist keeps the best-effort orphan cleanup from signalling a real process.
    workers[0]!.reply({ type: "spawned", id: request.id, pid: 2 ** 30, createMs: 1 });
    const child = await starting;
    const failure = new Promise<Error>((resolve) => child.once("error", resolve));
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    workers[0]!.emit("exit", 1);

    expect((await failure).message).toContain("Process host worker exited with code 1");
    await closed;
  });

  it("rejects options that cannot cross a thread boundary instead of ignoring them", async () => {
    const { host } = createHost();
    await expect(host.spawn("node", [], { stdio: "inherit" })).rejects.toThrow(/supports only "pipe" and "ignore"/);
    await expect(host.spawn("node", [], { timeout: 5 })).rejects.toThrow(/does not support the "timeout" option/);
  });
});
