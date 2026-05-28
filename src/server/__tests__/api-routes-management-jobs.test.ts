import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp } from "./helpers.js";
import { createManagementJobStore, type ManagementJobStore } from "../management-job-store.js";

function createManagementJobApiTestApp(): ReturnType<typeof createTestApp> & { store: ManagementJobStore } {
  const local = createTestApp();
  const dataDir = local.ctx.runtimePaths?.dataDir;
  if (!dataDir) throw new Error("test app is missing runtime data dir");
  const store = createManagementJobStore(local.db, { dataDir });
  local.ctx.managementJobStore = store;
  return { ...local, store };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("management job API routes", () => {
  it("lists jobs with filters, active counts, and stale metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T20:00:00.000Z"));
    vi.stubEnv("BRIDGE_MANAGEMENT_JOB_STALE_AFTER_MS", "1000");
    const { app, store } = createManagementJobApiTestApp();

    const running = store.enqueue("staging_preview", { stagingDir: "running" });
    expect(store.claimNext({ runnerPid: 4242, staleAfterMs: 1_000 })?.id).toBe(running.id);
    vi.setSystemTime(new Date("2026-05-18T20:00:00.500Z"));
    store.enqueue("staging_preview", { stagingDir: "queued" });
    vi.setSystemTime(new Date("2026-05-18T20:00:02.000Z"));

    const res = await request(app)
      .get("/api/management-jobs?type=staging_preview&status=running&limit=500");

    expect(res.status).toBe(200);
    expect(res.body.staleAfterMs).toBe(1_000);
    expect(res.body.activeCount).toBe(2);
    expect(res.body.runningCount).toBe(1);
    expect(res.body.queuedCount).toBe(1);
    expect(res.body.staleCount).toBe(1);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0]).toMatchObject({
      id: running.id,
      status: "running",
      stale: true,
      heartbeatAgeMs: 2_000,
      runnerPid: 4242,
    });
    expect(res.body.fetchedAt).toBe("2026-05-18T20:00:02.000Z");
  });

  it("rejects invalid list filters and limits", async () => {
    const { app } = createManagementJobApiTestApp();

    const invalidType = await request(app).get("/api/management-jobs?type=invalid");
    expect(invalidType.status).toBe(400);
    expect(invalidType.body.error).toContain("Unsupported management job type");

    const invalidLimit = await request(app).get("/api/management-jobs?limit=0");
    expect(invalidLimit.status).toBe(400);
    expect(invalidLimit.body.error).toContain("limit must be a positive integer");
  });

  it("returns detail with sanitized log tail", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const job = store.enqueue("staging_preview", { stagingDir: "detail" });
    if (!job.logPath) throw new Error("expected job log path");
    writeFileSync(job.logPath, "safe\n\u001b[31mred\u001b[0m\nnul:\u0000end", "utf-8");

    const res = await request(app).get(`/api/management-jobs/${job.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(job.id);
    expect(res.body.input).toEqual({ stagingDir: "detail" });
    expect(res.body.logTail).toContain("red");
    expect(res.body.logTail).not.toContain("\u001b");
    expect(res.body.logTail).toContain("�");
  });

  it("returns clamped sanitized log tails and validates tailBytes", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const job = store.enqueue("staging_preview", { stagingDir: "log" });
    if (!job.logPath) throw new Error("expected job log path");
    writeFileSync(job.logPath, "x".repeat(70 * 1024), "utf-8");

    const res = await request(app).get(`/api/management-jobs/${job.id}/log?tailBytes=1048576`);

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(job.id);
    expect(res.body.logTail).toHaveLength(64 * 1024);

    const invalid = await request(app).get(`/api/management-jobs/${job.id}/log?tailBytes=0`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("tailBytes must be a positive integer");
  });

  it("returns 404 for missing management jobs", async () => {
    const { app } = createManagementJobApiTestApp();

    expect((await request(app).get("/api/management-jobs/missing")).status).toBe(404);
    expect((await request(app).get("/api/management-jobs/missing/log")).status).toBe(404);
    expect((await request(app).post("/api/management-jobs/missing/cancel")).status).toBe(404);
    expect((await request(app).post("/api/management-jobs/missing/retry")).status).toBe(404);
  });

  it("cancels queued jobs and rejects running or terminal cancellation", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const queued = store.enqueue("staging_preview", { stagingDir: "cancel-queued" });

    const cancelled = await request(app).post(`/api/management-jobs/${queued.id}/cancel`);

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(store.get(queued.id)?.status).toBe("cancelled");

    const terminal = await request(app).post(`/api/management-jobs/${queued.id}/cancel`);
    expect(terminal.status).toBe(409);
    expect(terminal.body.job.status).toBe("cancelled");

    const running = store.enqueue("staging_preview", { stagingDir: "cancel-running" });
    expect(store.claimNext({ runnerPid: 7 })?.id).toBe(running.id);

    const runningCancel = await request(app).post(`/api/management-jobs/${running.id}/cancel`);
    expect(runningCancel.status).toBe(409);
    expect(runningCancel.body.job.status).toBe("running");
    expect(store.get(running.id)?.cancelRequestedAt).toBeUndefined();
  });

  it("rejects cross-site cancel and retry mutations", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const queued = store.enqueue("staging_preview", { stagingDir: "cross-site-cancel" });
    const failed = store.enqueue("staging_preview", { stagingDir: "cross-site-retry" });
    store.fail(failed.id, "boom");

    const cancel = await request(app)
      .post(`/api/management-jobs/${queued.id}/cancel`)
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test");
    expect(cancel.status).toBe(403);
    expect(store.get(queued.id)?.status).toBe("queued");

    const retry = await request(app)
      .post(`/api/management-jobs/${failed.id}/retry`)
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test");
    expect(retry.status).toBe(403);
  });

  it("retries failed or cancelled jobs with the same type and input", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const failed = store.enqueue("staging_preview", { stagingDir: "retry-failed", validate: false });
    store.fail(failed.id, "boom", { reason: "test" });

    const failedRetry = await request(app).post(`/api/management-jobs/${failed.id}/retry`);

    expect(failedRetry.status).toBe(200);
    expect(failedRetry.body.retriedFrom).toBe(failed.id);
    expect(failedRetry.body.job).toMatchObject({
      type: "staging_preview",
      status: "queued",
      input: { stagingDir: "retry-failed", validate: false },
    });
    expect(store.get(failedRetry.body.job.id)?.input).toEqual({ stagingDir: "retry-failed", validate: false });

    const cancelled = store.enqueue("staging_preview", { stagingDir: "retry-cancelled" });
    store.cancel(cancelled.id);

    const cancelledRetry = await request(app).post(`/api/management-jobs/${cancelled.id}/retry`);
    expect(cancelledRetry.status).toBe(200);
    expect(cancelledRetry.body.retriedFrom).toBe(cancelled.id);
    expect(cancelledRetry.body.job.status).toBe("queued");
  });

  it("returns retry conflicts for active jobs and active exclusive jobs", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const queued = store.enqueue("staging_preview", { stagingDir: "retry-queued" });

    const activeRetry = await request(app).post(`/api/management-jobs/${queued.id}/retry`);
    expect(activeRetry.status).toBe(409);
    expect(activeRetry.body.job.status).toBe("queued");

    const failedSelfUpdate = store.enqueue("self_update", { source: "failed" });
    store.fail(failedSelfUpdate.id, "self update failed");
    const activeDeploy = store.enqueue("staging_deploy", { stagingDir: "deploy", message: "Ship it" });

    const conflict = await request(app).post(`/api/management-jobs/${failedSelfUpdate.id}/retry`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.activeJob).toMatchObject({
      id: activeDeploy.id,
      type: "staging_deploy",
      status: "queued",
    });
  });
});
