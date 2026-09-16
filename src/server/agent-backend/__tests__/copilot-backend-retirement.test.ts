import { ChildProcess } from "node:child_process";
import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessIdentityStatuses, sampleProcessTree, terminateProcessTree } from "../../platform.js";
import { createDeadline } from "../../deadline.js";
import { RUNTIME_FENCE_BUDGET_MS, RUNTIME_FENCE_CHILD_EXIT_WAIT_MS, RUNTIME_FENCE_STARTUP_WAIT_MS } from "../runtime-fence.js";
import { CopilotBackend } from "../copilot-backend.js";
import { AGENT_RPC_TIMEOUTS_MS, AgentRpcTimeoutError } from "../rpc-timeouts.js";

vi.mock("../../platform.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../platform.js")>(),
  sampleProcessTree: vi.fn(),
  terminateProcessTree: vi.fn(),
  getProcessIdentityStatuses: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function sessionFixture(sendRequest = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ success: true }))) {
  // SDK hides this constructor in its declarations; exercise the installed implementation.
  const raw: CopilotSession = Reflect.construct(CopilotSession, ["retirement", { sendRequest }]);
  const client = new CopilotClient();
  vi.spyOn(client, "createSession").mockResolvedValue(raw);
  const backend = new CopilotBackend(client, { logger: { warn: vi.fn(), error: vi.fn() } });
  return { session: await backend.createSession({}), raw, sendRequest };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Copilot session retirement against the installed SDK", () => {
  it("joins the first disconnect rather than the SDK's early concurrent success", async () => {
    const detach = deferred<unknown>();
    const sendRequest = vi.fn(() => detach.promise);
    const { session, raw } = await sessionFixture(sendRequest);
    const disconnect = vi.spyOn(raw, "disconnect");
    const release = session.release!();
    expect(session.release!()).toBe(release);
    expect(session.disconnect!()).toBe(release);
    let released = false;
    void release.then(() => { released = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendRequest).toHaveBeenCalledWith("session.detach", { sessionId: "retirement" });
    expect(released).toBe(false);
    detach.resolve({ success: true });
    await expect(release).resolves.toEqual({ status: "released" });
    expect(session.release!()).toBe(release);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a failed detach cached rather than beginning another episode", async () => {
    const { session, raw } = await sessionFixture(vi.fn(async () => { throw new Error("lost"); }));
    const disconnect = vi.spyOn(raw, "disconnect");
    const first = session.release!();
    await expect(first).rejects.toThrow("lost");
    expect(session.release!()).toBe(first);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("retains the raw task slot after timeout, serializes mutations, and detaches only after late settlement", async () => {
    vi.useFakeTimers();
    const list = deferred<unknown>();
    const request = vi.fn(async (method: unknown): Promise<unknown> => {
      if (method === "session.tasks.list") return list.promise;
      if (method === "session.tasks.cancel") return { cancelled: false };
      return { success: true };
    });
    const { session } = await sessionFixture(request);
    const listing = session.listTasks();
    const timedOut = expect(listing).rejects.toBeInstanceOf(AgentRpcTimeoutError);
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["session.listTasks"]);
    await timedOut;
    const cancelling = session.cancelTask("agent");
    const release = session.release!();
    await Promise.resolve();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["session.tasks.list"]);
    await expect(session.removeTask("agent")).rejects.toThrow("intake is closed");
    list.resolve({ tasks: [] });
    await expect(cancelling).resolves.toEqual({ cancelled: false });
    await expect(release).resolves.toEqual({ status: "released" });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "session.tasks.list", "session.tasks.cancel", "session.detach",
    ]);
  });

  it("does not apply the session.destroy timeout to release", async () => {
    vi.useFakeTimers();
    const detach = deferred<unknown>();
    const { session } = await sessionFixture(vi.fn(() => detach.promise));
    const release = session.release!();
    let settled = false;
    void release.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["session.destroy"] + 1);
    expect(settled).toBe(false);
    detach.resolve({ success: true });
    await expect(release).resolves.toEqual({ status: "released" });
  });

  it("reports unsupported detach rather than success", async () => {
    const { session, raw } = await sessionFixture();
    Reflect.set(raw, "disconnect", undefined);
    await expect(session.release!()).resolves.toMatchObject({ status: "unsupported" });
  });

  it("allows detach after a raw task failure settles but does not retry that operation", async () => {
    const request = vi.fn(async (method: unknown) => {
      if (method === "session.tasks.cancel") throw new Error("cancel failed");
      return { success: true };
    });
    const { session } = await sessionFixture(request);
    await expect(session.cancelTask("agent")).rejects.toThrow("cancel failed");
    await expect(session.release!()).resolves.toEqual({ status: "released" });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["session.tasks.cancel", "session.detach"]);
  });

  it.each([
    ["list", {}], ["list", { tasks: [null] }], ["list", { tasks: [{ id: "" }] }],
    ["cancel", {}], ["cancel", { cancelled: "yes" }], ["remove", { removed: 1 }],
  ])("rejects malformed %s results instead of reporting empty or successful cleanup", async (operation, value) => {
    const { session } = await sessionFixture(vi.fn(async () => value));
    const result = operation === "list" ? session.listTasks()
      : operation === "cancel" ? session.cancelTask("agent") : session.removeTask("agent");
    await expect(result).rejects.toThrow("Malformed");
  });
});

const root = { pid: 4242, startMarker: "loader" };
const runtime = { pid: 4243, startMarker: "native-runtime" };

function backendFixture(startup?: Promise<void>) {
  const child = Object.assign(new ChildProcess(), { pid: root.pid });
  const client = new CopilotClient();
  const start = vi.spyOn(client, "start").mockImplementation(async () => {
    Reflect.set(client, "cliProcess", child);
    if (startup) await startup;
  });
  vi.mocked(sampleProcessTree).mockResolvedValue({ root, descendants: [runtime] });
  vi.mocked(getProcessIdentityStatuses).mockImplementation(async (identities) =>
    new Map(identities.map((identity) => [identity, "unknown" as const])));
  vi.mocked(terminateProcessTree).mockImplementation(async (identity) => {
    if (identity.pid === root.pid) {
      Reflect.set(child, "exitCode", 0);
      child.emit("exit", 0, null);
    }
    return { ok: true, status: "terminated", root: identity };
  });
  const backend = new CopilotBackend(client, { localStdioOwnership: true });
  return { backend, client, child, start };
}

describe("Copilot owned-runtime fence", () => {
  it.each(["linux", "win32"] as const)("uses the platform boundary and retained native runtime identity on %s", async (platform) => {
    const { backend, client } = backendFixture();
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    try {
      await backend.start();
      Reflect.set(client, "cliProcess", null);
      const fence = backend.fence();
      expect(backend.fence()).toBe(fence);
      await fence;
      expect(vi.mocked(terminateProcessTree).mock.calls.map(([identity]) => identity)).toEqual([runtime, root]);
      await expect(backend.start()).rejects.toThrow("fenced");
      await expect(client.start()).rejects.toThrow("fenced");
      await expect(backend.createSession({})).rejects.toThrow("fenced");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("skips captured workers only after their parent subtree has been verified gone", async () => {
    const { backend } = backendFixture();
    const workers = [{ pid: 5001, startMarker: "worker-one" }, { pid: 5002, startMarker: "worker-two" }];
    vi.mocked(sampleProcessTree).mockResolvedValue({ root, descendants: [runtime, ...workers, runtime] });
    const terminate = vi.mocked(terminateProcessTree).getMockImplementation();
    vi.mocked(terminateProcessTree).mockImplementation(async (identity, deadline, onPhase) => {
      if (identity === runtime) return { ok: true, status: "terminated", root: runtime,
        snapshot: { root: runtime, descendants: workers } };
      return terminate!(identity, deadline, onPhase);
    });
    await backend.start();
    await backend.fence();
    expect(vi.mocked(terminateProcessTree).mock.calls.map(([identity]) => identity)).toEqual([runtime, root]);
  });

  it("still fences retained orphans when the captured native parent has already exited", async () => {
    const { backend } = backendFixture();
    const orphan = { pid: 5001, startMarker: "orphan" };
    vi.mocked(sampleProcessTree).mockResolvedValue({ root, descendants: [runtime, orphan] });
    vi.mocked(terminateProcessTree).mockResolvedValueOnce({ ok: true, status: "already-exited", root: runtime });
    await backend.start();
    await backend.fence();
    expect(vi.mocked(terminateProcessTree).mock.calls.map(([identity]) => identity)).toEqual([runtime, orphan, root]);
  });

  it("verifies all survivors together and removes only confirmed-exited identities", async () => {
    vi.useFakeTimers();
    const { backend } = backendFixture();
    const other = { pid: 5001, startMarker: "worker" };
    vi.mocked(terminateProcessTree).mockResolvedValueOnce({ ok: false, status: "survivors", root: runtime,
      snapshot: { root: runtime, descendants: [other] }, survivors: [runtime, other] });
    vi.mocked(getProcessIdentityStatuses).mockResolvedValueOnce(new Map([[runtime, "alive"], [other, "alive"]]))
      .mockResolvedValueOnce(new Map([[runtime, "exited"], [other, "alive"]]))
      .mockResolvedValueOnce(new Map([[other, "replaced"]]));
    await backend.start();
    const fence = backend.fence();
    await vi.advanceTimersByTimeAsync(200);
    await expect(fence).resolves.toBeUndefined();
    expect(vi.mocked(getProcessIdentityStatuses).mock.calls.map(([identities]) => identities))
      .toEqual([[runtime, other], [runtime, other], [other]]);
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });

  it("does not equate a stopped loader with an exited native runtime", async () => {
    const { backend, child, client } = backendFixture();
    await backend.start();
    Reflect.set(child, "exitCode", 0);
    Reflect.set(client, "cliProcess", null);
    vi.mocked(terminateProcessTree).mockResolvedValue({ ok: false, status: "survivors", root: runtime, survivors: [runtime] });
    const fence = backend.fence();
    await expect(fence).rejects.toThrow("survivors");
    expect(backend.fence()).toBe(fence);
  });

  it("fails closed on unknown ownership, external servers and FFI", async () => {
    await expect(new CopilotBackend(new CopilotClient()).fence()).rejects.toThrow("unknown");
    for (const field of ["isExternalServer", "ffiHost"]) {
      const { backend, client } = backendFixture();
      Reflect.set(client, field, true);
      await expect(backend.fence()).rejects.toThrow("external, FFI");
    }
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("does not release ownership when the raw startup can still spawn late", async () => {
    vi.useFakeTimers();
    const startup = deferred<void>();
    const { backend, start } = backendFixture(startup.promise);
    const starting = backend.start();
    const fence = backend.fence();
    const rejected = expect(fence).rejects.toThrow("startup is still pending");
    await vi.advanceTimersByTimeAsync(RUNTIME_FENCE_STARTUP_WAIT_MS);
    await rejected;
    expect(terminateProcessTree).not.toHaveBeenCalled();
    startup.resolve();
    await starting;
    expect(backend.fence()).toBe(fence);
    await expect(backend.start()).rejects.toThrow("fenced");
    expect(start).toHaveBeenCalledOnce();
  });

  it("fences a never-started owned client without spawning it later", async () => {
    const { backend, start } = backendFixture();
    await backend.fence();
    await expect(backend.start()).rejects.toThrow("fenced");
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a missing native-runtime snapshot even if SDK forceStop fulfills", async () => {
    const { backend, client } = backendFixture();
    vi.mocked(sampleProcessTree).mockResolvedValue({ root, descendants: [] });
    await backend.start();
    vi.spyOn(client, "forceStop").mockResolvedValue();
    await backend.forceStop();
    await expect(backend.fence()).rejects.toThrow("Cannot prove ownership");
  });

  it("requires SDK child exit even after the platform reports the process tree gone", async () => {
    vi.useFakeTimers();
    const { backend, child } = backendFixture();
    await backend.start();
    vi.mocked(terminateProcessTree).mockImplementation(async (identity) => ({
      ok: true, status: "already-exited", root: identity,
    }));
    const baseline = child.listenerCount("exit");
    const fence = expect(backend.fence()).rejects.toThrow("child exit is unconfirmed");
    await vi.advanceTimersByTimeAsync(RUNTIME_FENCE_CHILD_EXIT_WAIT_MS);
    await fence;
    expect(child.listenerCount("exit")).toBeLessThanOrEqual(baseline);
  });

  it("retains the child and runtime identities through the real SDK forceStop", async () => {
    const { backend, child, client } = backendFixture();
    vi.spyOn(child, "kill").mockReturnValue(true);
    await backend.start();
    await backend.forceStop();
    expect(Reflect.get(client, "cliProcess")).toBeNull();
    expect(child.exitCode).toBeNull();
    vi.mocked(terminateProcessTree).mockResolvedValue({ ok: false, status: "survivors", root: runtime });
    await expect(backend.fence()).rejects.toThrow("survivors");
  });

  it("captures the native runtime before SDK failure cleanup clears the child", async () => {
    const child = Object.assign(new ChildProcess(), { pid: root.pid });
    vi.spyOn(child, "kill").mockReturnValue(true);
    const client = new CopilotClient();
    vi.spyOn(client, "start").mockImplementation(async () => {
      Reflect.set(client, "cliProcess", child);
      await client.forceStop();
      throw new Error("protocol startup failed");
    });
    vi.mocked(sampleProcessTree).mockResolvedValue({ root, descendants: [runtime] });
    vi.mocked(terminateProcessTree).mockImplementation(async (identity) => {
      Reflect.set(child, "exitCode", 0);
      return { ok: true, status: "terminated", root: identity };
    });
    const backend = new CopilotBackend(client, { localStdioOwnership: true });
    await expect(backend.start()).rejects.toThrow("protocol startup failed");
    expect(Reflect.get(client, "cliProcess")).toBeNull();
    await expect(backend.fence()).resolves.toBeUndefined();
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });

  it("waits within the fence budget for signalled runtime processes to actually exit", async () => {
    vi.useFakeTimers();
    const { backend } = backendFixture();
    await backend.start();
    vi.mocked(terminateProcessTree).mockResolvedValueOnce({
      ok: false, status: "survivors", root: runtime, survivors: [runtime],
    });
    vi.mocked(getProcessIdentityStatuses).mockResolvedValueOnce(new Map([[runtime, "alive"]]))
      .mockResolvedValueOnce(new Map([[runtime, "exited"]]));
    const fence = backend.fence();
    await vi.advanceTimersByTimeAsync(100);
    await expect(fence).resolves.toBeUndefined();
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
    expect(getProcessIdentityStatuses).toHaveBeenCalledTimes(2);
  });

  it("rejects a runtime that remains alive after the caller's verification budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const { backend } = backendFixture();
    await backend.start();
    vi.mocked(terminateProcessTree).mockResolvedValueOnce({
      ok: false, status: "survivors", root: runtime, survivors: [runtime],
    });
    vi.mocked(getProcessIdentityStatuses).mockResolvedValue(new Map([[runtime, "alive"]]));
    const fence = backend.fence({ deadline: createDeadline(3_000) });
    const rejected = expect(fence).rejects.toThrow("survivors");
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(backend.fence()).toBe(fence);
    expect(terminateProcessTree).toHaveBeenCalledOnce();
  });
});
