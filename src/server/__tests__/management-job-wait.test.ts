import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, openMemoryDatabase } from "../db.js";
import type { AppContext } from "../app-context.js";
import { createManagementJobStore } from "../management-job-store.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { managementJobDeliveryId } from "../management-job-delivery.js";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import type { BridgeToolHandlerResult } from "../agent-tools-mcp/server.js";
import {
  MANAGEMENT_JOB_WAIT_INTERVAL_MS,
  MANAGEMENT_JOB_WAIT_TIMEOUT_MS,
  registerManagementJobTools,
} from "../tools/management-job-tools.js";
import { makeTestDir } from "./helpers.js";

const SESSION = "preview-origin";
const cleanups: Array<() => void> = [];
const controllers: AbortController[] = [];
const calls: Array<Promise<BridgeToolHandlerResult>> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(calls.splice(0));
  while (cleanups.length) cleanups.pop()!();
  vi.useRealTimers();
});

function setup() {
  const db = openMemoryDatabase();
  const dataDir = makeTestDir("management-job-wait");
  const store = createManagementJobStore(db, { dataDir });
  const prompts = createDeferredPromptStore(db);
  const ctx = { managementJobStore: store, deferredPromptStore: prompts } as AppContext;
  const server = new BridgeToolsMcpServer(ctx);
  registerManagementJobTools(server, ctx);
  const tool = server.getToolDefinitions().find((definition) => definition.name === "management_job_wait");
  if (!tool) throw new Error("Expected the wait tool");
  cleanups.push(() => db.close());
  const wait = (jobId: string, sessionId = SESSION, controller = new AbortController()) => {
    controllers.push(controller);
    const call = Promise.resolve(tool.handler({ jobId }, { sessionId, signal: controller.signal }));
    calls.push(call);
    return call;
  };
  return { db, store, prompts, wait, tool };
}

describe("management_job_wait", () => {
  it("stays pending through queued/running states, returns the final result and consumes its delivery", async () => {
    const { store, prompts, wait } = setup();
    const job = store.enqueue("staging_preview", { stagingDir: "wait-preview" }, { originSessionId: SESSION });
    const completed = vi.fn();
    const call = wait(job.id).then((result) => { completed(); return result; });
    await vi.advanceTimersByTimeAsync(MANAGEMENT_JOB_WAIT_INTERVAL_MS);
    expect(completed).not.toHaveBeenCalled();
    store.claimNext({ runnerPid: 123 });
    await vi.advanceTimersByTimeAsync(MANAGEMENT_JOB_WAIT_INTERVAL_MS);
    expect(completed).not.toHaveBeenCalled();
    store.succeed(job.id, { previewUrl: "https://bridge.example/staging/wait/" });
    expect(prompts.get(managementJobDeliveryId(job.id))?.status).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(MANAGEMENT_JOB_WAIT_INTERVAL_MS);
    await expect(call).resolves.toMatchObject({
      success: true, terminal: true, status: "succeeded",
      result: { previewUrl: "https://bridge.example/staging/wait/" },
      resultDelivery: { status: "completed" },
    });
    expect(store.reconcileResultDeliveries()).toBe(0);
    expect(prompts.listDue(new Date().toISOString())).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["failed", "cancelled"] as const)("returns a %s preview without another completion message", async (status) => {
    const { store, wait, prompts } = setup();
    const job = store.enqueue("staging_preview", {}, { originSessionId: SESSION });
    const call = wait(job.id);
    if (status === "failed") store.fail(job.id, "Validation failed.");
    else store.cancel(job.id, "Preview cancelled.");
    await vi.advanceTimersByTimeAsync(MANAGEMENT_JOB_WAIT_INTERVAL_MS);
    await expect(call).resolves.toMatchObject({ success: true, terminal: true, status, error: expect.any(String) });
    expect(prompts.listDue(new Date().toISOString())).toEqual([]);
  });

  it("returns an already-finished result immediately", async () => {
    const { store, wait, prompts } = setup();
    const job = store.enqueue("staging_preview", {}, { originSessionId: SESSION });
    store.fail(job.id, "Already failed.");
    await expect(wait(job.id)).resolves.toMatchObject({ terminal: true, status: "failed", error: "Already failed." });
    expect(prompts.get(managementJobDeliveryId(job.id))?.status).toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels promptly without cancelling the preview, and allows a later wait", async () => {
    const { store, wait, prompts } = setup();
    const job = store.enqueue("staging_preview", {}, { originSessionId: SESSION });
    const controller = new AbortController();
    const call = wait(job.id, SESSION, controller);
    controller.abort();
    await expect(call).resolves.toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("cancelled") });
    expect(store.get(job.id)?.status).toBe("queued");
    expect(vi.getTimerCount()).toBe(0);
    const retry = wait(job.id);
    store.succeed(job.id, { previewUrl: "https://bridge.example/staging/retry/" });
    await vi.advanceTimersByTimeAsync(MANAGEMENT_JOB_WAIT_INTERVAL_MS);
    await expect(retry).resolves.toMatchObject({ success: true, status: "succeeded" });
    expect(prompts.get(managementJobDeliveryId(job.id))?.status).toBe("completed");
  });

  it("does not recreate a wake-up after cancellation and a separate runner finishes the job", async () => {
    const { db, store, wait, prompts } = setup();
    const job = store.enqueue("staging_preview", {}, { originSessionId: SESSION });
    const controller = new AbortController();
    const call = wait(job.id, SESSION, controller);
    controller.abort();
    await call;
    const otherStore = createManagementJobStore(db, { dataDir: makeTestDir("management-job-wait-runner") });
    otherStore.succeed(job.id, { previewUrl: "https://bridge.example/staging/late/" });
    otherStore.succeed(job.id, { previewUrl: "https://bridge.example/staging/late/" });
    expect(store.reconcileResultDeliveries()).toBe(0);
    expect(prompts.get(managementJobDeliveryId(job.id))?.status).toBe("cancelled");
    expect(prompts.listDue(new Date().toISOString())).toEqual([]);
  });

  it("preserves delivery suppression across a server restart while the runner completes the job", () => {
    const dataDir = makeTestDir("management-job-wait-restart");
    const server = openDatabase(dataDir);
    const runner = openDatabase(dataDir);
    let serverClosed = false;
    try {
      const serverStore = createManagementJobStore(server, { dataDir });
      const job = serverStore.enqueue("staging_preview", {}, { originSessionId: SESSION });
      serverStore.suppressResultDelivery(job, SESSION, "The waiter owns this preview result.");
      server.close();
      serverClosed = true;
      createManagementJobStore(runner, { dataDir }).succeed(job.id, { previewUrl: "https://bridge.example/staging/restart/" });
      const restarted = openDatabase(dataDir);
      try {
        const restartedStore = createManagementJobStore(restarted, { dataDir });
        const restartedPrompts = createDeferredPromptStore(restarted);
        expect(restartedStore.reconcileResultDeliveries()).toBe(0);
        expect(restartedPrompts.get(managementJobDeliveryId(job.id))?.status).toBe("cancelled");
        expect(restartedStore.markResultSeen(restartedStore.get(job.id)!)).toBe(true);
        expect(restartedPrompts.get(managementJobDeliveryId(job.id))?.status).toBe("completed");
      } finally { restarted.close(); }
    } finally {
      if (!serverClosed) server.close();
      runner.close();
    }
  });

  it("does not take another session's completion message", async () => {
    const { store, wait, prompts } = setup();
    const job = store.enqueue("staging_preview", {}, { originSessionId: "someone-else" });
    const call = wait(job.id);
    store.succeed(job.id, {});
    await vi.advanceTimersByTimeAsync(MANAGEMENT_JOB_WAIT_INTERVAL_MS);
    await expect(call).resolves.toMatchObject({ success: true, resultDelivery: { status: "pending" } });
    expect(prompts.get(managementJobDeliveryId(job.id))?.status).toBe("pending");
  });

  it("returns a stalled runner explicitly without waiting indefinitely", async () => {
    const { store, wait } = setup();
    const job = store.enqueue("staging_preview", {});
    store.claimNext({ runnerPid: 1 });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await expect(wait(job.id)).resolves.toMatchObject({ terminal: true, stalled: true, status: "running" });
  });

  it("bounds a queued wait and reports the timeout without cancelling the job", async () => {
    const { store, wait } = setup();
    const job = store.enqueue("staging_preview", {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const call = wait(job.id);
      vi.setSystemTime(Date.now() + MANAGEMENT_JOB_WAIT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(MANAGEMENT_JOB_WAIT_INTERVAL_MS);
      await expect(call).resolves.toMatchObject({
        resultType: "failure",
        textResultForLlm: expect.stringContaining("exceeded 25 minutes"),
      });
      expect(store.get(job.id)?.status).toBe("queued");
      expect(error).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { error.mockRestore(); }
  });

  it.each(["staging_deploy", "self_update"] as const)("rejects %s waits that could block a restart", async (type) => {
    const { store, wait, prompts } = setup();
    const job = store.enqueue(type, {}, { originSessionId: SESSION });
    await expect(wait(job.id)).resolves.toMatchObject({ resultType: "failure" });
    expect(prompts.get(managementJobDeliveryId(job.id))).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unknown jobs and invalid arguments without opening a wait", async () => {
    const { wait, tool } = setup();
    await expect(wait("missing")).resolves.toMatchObject({ resultType: "failure" });
    await expect(tool.handler({}, {})).resolves.toMatchObject({ resultType: "failure" });
    await expect(tool.handler({ jobId: {} }, {})).resolves.toMatchObject({ resultType: "failure" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses all outstanding preview results on Stop, leaving other sessions and deploys alone", () => {
    const { store, prompts } = setup();
    const pending = store.enqueue("staging_preview", { stagingDir: "queued" }, { originSessionId: SESSION });
    const finished = store.enqueue("staging_preview", { stagingDir: "finished" }, { originSessionId: SESSION });
    store.fail(finished.id, "Finished before Stop.");
    const other = store.enqueue("staging_preview", { stagingDir: "other" }, { originSessionId: "other" });
    const deploy = store.enqueue("staging_deploy", {}, { originSessionId: SESSION });
    expect(store.suppressPreviewResultDeliveries(SESSION)).toBe(2);
    store.succeed(pending.id, {});
    store.succeed(other.id, {});
    expect(prompts.get(managementJobDeliveryId(pending.id))?.status).toBe("cancelled");
    expect(prompts.get(managementJobDeliveryId(finished.id))?.status).toBe("cancelled");
    expect(prompts.get(managementJobDeliveryId(other.id))?.status).toBe("pending");
    expect(prompts.get(managementJobDeliveryId(deploy.id))).toBeUndefined();
    expect(store.reconcileResultDeliveries()).toBe(0);
  });
});
