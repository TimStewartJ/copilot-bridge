import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsProcessTableReader } from "../windows-process-table.js";

function fixture({ autoReady = true }: { autoReady?: boolean } = {}) {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(), ref: vi.fn(), unref: vi.fn(), terminate: vi.fn(async () => 0),
  });
  // The reader subscribes right after createWorker returns, so a queued ready arrives after it listens.
  const createWorker = vi.fn(() => {
    if (autoReady) queueMicrotask(() => worker.emit("message", { ready: true }));
    return worker;
  });
  const reader = new WindowsProcessTableReader({ createWorker });
  return { worker, reader, createWorker, ready: () => worker.emit("message", { ready: true }) };
}
const entries = [{ pid: 100, ppid: 1, startMarker: "1000" }];
afterEach(() => { vi.useRealTimers(); });

describe("bounded Windows snapshot worker", () => {
  it("returns an explicit completion and reuses its worker without caching snapshots", async () => {
    const f = fixture();
    const first = f.reader.read(20_000);
    f.worker.emit("message", { id: 1, entries });
    await expect(first).resolves.toEqual(entries);
    const second = f.reader.read(20_000);
    f.worker.emit("message", { id: 2, entries: [] });
    await expect(second).resolves.toEqual([]);
    expect(f.createWorker).toHaveBeenCalledOnce();
    expect(f.worker.postMessage).toHaveBeenCalledTimes(2);
    expect(f.worker.ref).toHaveBeenCalledTimes(2);
    await f.reader.shutdown();
  });

  it("keeps simultaneous requests separate and resolves only the matching identity", async () => {
    const f = fixture();
    const first = f.reader.read(20_000);
    const second = f.reader.read(20_000);
    f.worker.emit("message", { id: 2, entries: [] });
    await expect(second).resolves.toEqual([]);
    f.worker.emit("message", { id: 1, entries });
    await expect(first).resolves.toEqual(entries);
    await f.reader.shutdown();
  });

  it("times out on the calling thread, rejects all queued reads, and refuses late replies from the old worker", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.reader.read(20_000);
    const second = f.reader.read(30_000);
    const rejected = Promise.all([
      expect(first).rejects.toThrow("timed out after 20000ms"),
      expect(second).rejects.toThrow("timed out after 20000ms"),
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(f.worker.terminate).toHaveBeenCalledOnce();

    const fresh = fixture();
    f.createWorker.mockImplementation(fresh.createWorker);
    const resumed = f.reader.read(20_000);
    f.worker.emit("message", { id: 3, entries });
    fresh.worker.emit("message", { id: 3, entries: [] });
    await expect(resumed).resolves.toEqual([]);
    await f.reader.shutdown();
  });

  it.each([
    { invalid: [{ pid: 0, ppid: 1, startMarker: "1000" }] },
    { invalid: [{ pid: 100, ppid: -1, startMarker: "1000" }] },
    { invalid: [{ pid: 100, ppid: 1, startMarker: "invalid" }] },
    { invalid: [entries[0], entries[0]] },
  ])("rejects malformed or duplicate identities: %j", async ({ invalid }) => {
    const f = fixture();
    const read = f.reader.read(20_000);
    f.worker.emit("message", { id: 1, entries: invalid });
    await expect(read).rejects.toThrow("invalid or duplicate identity");
    await f.reader.shutdown();
  });

  it("preserves missing markers as unknown identities", async () => {
    const f = fixture();
    const read = f.reader.read(20_000);
    f.worker.emit("message", { id: 1, entries: [{ ...entries[0], startMarker: "" }] });
    await expect(read).resolves.toEqual([{ ...entries[0], startMarker: "" }]);
    await f.reader.shutdown();
  });

  it("reports native errors instead of returning an empty success table", async () => {
    const f = fixture();
    const read = f.reader.read(20_000);
    f.worker.emit("message", { id: 1, error: "native enumeration unavailable" });
    await expect(read).rejects.toThrow("native enumeration unavailable");
    await f.reader.shutdown();
  });

  it("fails pending reads when the worker errors or exits", async () => {
    for (const event of ["error", "exit"] as const) {
      const f = fixture();
      const read = f.reader.read(20_000);
      f.worker.emit(event, event === "error" ? new Error("worker failure") : 3);
      await expect(read).rejects.toThrow(event === "error" ? "worker failure" : "exited with code 3");
    }
  });

  it("does not create a worker for an expired deadline and propagates creation failure", async () => {
    const f = fixture();
    await expect(f.reader.read(0)).rejects.toThrow("deadline exceeded");
    expect(f.createWorker).not.toHaveBeenCalled();
    f.createWorker.mockImplementation(() => { throw new Error("worker creation failed"); });
    await expect(f.reader.read(20_000)).rejects.toThrow("worker creation failed");
  });

  it.each([{}, { id: 0 }, { id: 1.5 }])("fails closed on a malformed worker envelope: %j", async (reply) => {
    const f = fixture();
    const read = f.reader.read(20_000);
    f.worker.emit("message", reply);
    await expect(read).rejects.toThrow("malformed reply");
    await vi.waitFor(() => expect(f.worker.terminate).toHaveBeenCalledOnce());
    await f.reader.shutdown();
  });

  it("never stops a worker that is still loading koffi and stops it once loaded", async () => {
    vi.useFakeTimers();
    const f = fixture({ autoReady: false });
    const first = f.reader.read(1_000);
    const timedOut = expect(first).rejects.toThrow("timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;
    expect(f.worker.terminate).not.toHaveBeenCalled();

    const second = f.reader.read(20_000);
    expect(f.createWorker).toHaveBeenCalledOnce();
    f.worker.emit("message", { id: 2, entries });
    await expect(second).resolves.toEqual(entries);

    f.worker.emit("message", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.terminate).not.toHaveBeenCalled();
    f.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });

  it("waits for a loading worker before shutting it down", async () => {
    const f = fixture({ autoReady: false });
    const read = f.reader.read(20_000);
    const rejection = expect(read).rejects.toThrow("reader shut down");
    const shutdown = f.reader.shutdown();
    await rejection;
    expect(f.worker.terminate).not.toHaveBeenCalled();
    f.ready();
    await shutdown;
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });

  it("propagates message delivery failure without leaving a pending deadline", async () => {
    const f = fixture();
    f.worker.postMessage.mockImplementation(() => { throw new Error("worker channel closed"); });
    await expect(f.reader.read(20_000)).rejects.toThrow("worker channel closed");
    await f.reader.shutdown();
  });

  it("rejects in-flight reads during shutdown", async () => {
    const f = fixture();
    const read = f.reader.read(20_000);
    const rejection = expect(read).rejects.toThrow("reader shut down");
    await f.reader.shutdown();
    await rejection;
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });
});
