import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp, makeTestDir } from "./helpers.js";
import { createManagementJobStore, type ManagementJobStore } from "../management-job-store.js";
import { clearRestartPending, triggerRestartPending } from "../restart-controller.js";

function createManagementJobApiTestApp(): ReturnType<typeof createTestApp> & { store: ManagementJobStore } {
  const local = createTestApp();
  const dataDir = local.ctx.runtimePaths?.dataDir;
  if (!dataDir) throw new Error("test app is missing runtime data dir");
  const store = createManagementJobStore(local.db, { dataDir });
  local.ctx.managementJobStore = store;
  return { ...local, store };
}

function makeRealStagingDir(label: string): string {
  return makeTestDir(`bridge-mgmt-enqueue-${label}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearRestartPending();
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

  it("retries failed or cancelled jobs with the same type and normalized input", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const failedDir = makeRealStagingDir("retry-failed");
    const failed = store.enqueue("staging_preview", { stagingDir: failedDir, validate: false });
    store.fail(failed.id, "boom", { reason: "test" });

    const failedRetry = await request(app).post(`/api/management-jobs/${failed.id}/retry`);

    expect(failedRetry.status).toBe(200);
    expect(failedRetry.body.reused).toBe(false);
    expect(failedRetry.body.retriedFrom).toBe(failed.id);
    expect(failedRetry.body.job).toMatchObject({
      type: "staging_preview",
      status: "queued",
      input: { stagingDir: failedDir, validate: false },
    });
    // Retry routes through the shared enqueue helper, so the new job stores the
    // normalized input (profile added, explicit validate preserved).
    expect(store.get(failedRetry.body.job.id)?.input).toEqual({
      stagingDir: failedDir,
      validate: false,
      profile: "clone",
    });

    const cancelledDir = makeRealStagingDir("retry-cancelled");
    const cancelled = store.enqueue("staging_preview", { stagingDir: cancelledDir });
    store.cancel(cancelled.id);

    const cancelledRetry = await request(app).post(`/api/management-jobs/${cancelled.id}/retry`);
    expect(cancelledRetry.status).toBe(200);
    expect(cancelledRetry.body.reused).toBe(false);
    expect(cancelledRetry.body.retriedFrom).toBe(cancelled.id);
    expect(cancelledRetry.body.job.status).toBe("queued");
    expect(store.get(cancelledRetry.body.job.id)?.input).toEqual({
      stagingDir: cancelledDir,
      validate: true,
      profile: "clone",
    });
  });

  it("returns 400 when retrying a staging_preview whose stagingDir no longer exists", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const stagingDir = makeRealStagingDir("retry-missing-dir");
    const failed = store.enqueue("staging_preview", { stagingDir });
    store.fail(failed.id, "boom");

    rmSync(stagingDir, { recursive: true, force: true });

    const res = await request(app).post(`/api/management-jobs/${failed.id}/retry`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Staging directory not found");
    // The shared helper rejects before enqueuing, so no replacement job is created.
    expect(store.listActive(["staging_preview"])).toHaveLength(0);
  });

  it("reuses an active matching preview job when retrying a failed preview", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const stagingDir = makeRealStagingDir("retry-reuse-preview");
    const failed = store.enqueue("staging_preview", { stagingDir });
    store.fail(failed.id, "boom");
    // An equivalent preview is already active (e.g. a rapid double-click retry).
    const active = store.enqueue("staging_preview", { stagingDir, validate: true, profile: "clone" });

    const res = await request(app).post(`/api/management-jobs/${failed.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.retriedFrom).toBe(failed.id);
    expect(res.body.job.id).toBe(active.id);
    // No replacement job: only the single active preview remains.
    expect(store.listActive(["staging_preview"])).toHaveLength(1);
  });

  it("reuses an active self_update when retrying a failed self_update", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const failed = store.enqueue("self_update", { source: "old" });
    store.fail(failed.id, "boom");
    const active = store.enqueue("self_update", {});

    const res = await request(app).post(`/api/management-jobs/${failed.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.job.id).toBe(active.id);
    expect(store.listActive(["self_update"])).toHaveLength(1);
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

  describe("POST /management-jobs", () => {
    it("enqueues a new self_update job and emits a changed event", async () => {
      const { app, store, ctx } = createManagementJobApiTestApp();
      const events: unknown[] = [];
      const unsubscribe = ctx.globalBus.subscribe((event) => {
        if ((event as { type?: string }).type === "management-job:changed") {
          events.push(event);
        }
      });

      try {
        const res = await request(app)
          .post("/api/management-jobs")
          .send({ type: "self_update" });

        expect(res.status).toBe(201);
        expect(res.body.reused).toBe(false);
        expect(res.body.status).toBe("queued");
        expect(typeof res.body.jobId).toBe("string");
        expect(res.body.enqueuedAt).toBe(res.body.job.createdAt);
        expect(res.body.job).toMatchObject({ type: "self_update", input: {} });
        expect(store.get(res.body.jobId)?.type).toBe("self_update");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ jobId: res.body.jobId, jobType: "self_update" });
      } finally {
        unsubscribe();
      }
    });

    it("returns the existing self_update job on duplicate POST with reused: true", async () => {
      const { app, ctx } = createManagementJobApiTestApp();
      const events: unknown[] = [];
      const unsubscribe = ctx.globalBus.subscribe((event) => {
        if ((event as { type?: string }).type === "management-job:changed") events.push(event);
      });
      try {
        const first = await request(app).post("/api/management-jobs").send({ type: "self_update" });
        expect(first.status).toBe(201);
        expect(events).toHaveLength(1);

        const second = await request(app).post("/api/management-jobs").send({ type: "self_update" });
        expect(second.status).toBe(200);
        expect(second.body.reused).toBe(true);
        expect(second.body.jobId).toBe(first.body.jobId);
        expect(second.body.enqueuedAt).toBe(first.body.enqueuedAt);
        // No second emission for idempotent reuse.
        expect(events).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });

    it("returns 409 with activeJob when a different exclusive job is active", async () => {
      const { app, store } = createManagementJobApiTestApp();
      const stagingDir = makeRealStagingDir("conflict-deploy");
      const deploy = store.enqueue("staging_deploy", { stagingDir, message: "Ship it" });

      const res = await request(app).post("/api/management-jobs").send({ type: "self_update" });

      expect(res.status).toBe(409);
      expect(res.body.activeJob).toMatchObject({
        id: deploy.id,
        type: "staging_deploy",
        status: "queued",
      });
      expect(res.body.error).toContain("staging_deploy");
    });

    it("reuses an active staging_preview job when stagingDir, profile, and validate match", async () => {
      const { app } = createManagementJobApiTestApp();
      const stagingDir = makeRealStagingDir("preview-reuse");

      const first = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir } });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir } });
      expect(second.status).toBe(200);
      expect(second.body.reused).toBe(true);
      expect(second.body.jobId).toBe(first.body.jobId);
    });

    it("treats validate mismatches as conflicts in both directions", async () => {
      const { app } = createManagementJobApiTestApp();
      const dirA = makeRealStagingDir("preview-validate-tf");
      const dirB = makeRealStagingDir("preview-validate-ft");

      const validateFalseFirst = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir: dirA, validate: false } });
      expect(validateFalseFirst.status).toBe(201);
      const validateTrueSecond = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir: dirA, validate: true } });
      expect(validateTrueSecond.status).toBe(409);
      expect(validateTrueSecond.body.activeJob.id).toBe(validateFalseFirst.body.jobId);

      const validateTrueFirst = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir: dirB, validate: true } });
      expect(validateTrueFirst.status).toBe(201);
      const validateFalseSecond = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir: dirB, validate: false } });
      expect(validateFalseSecond.status).toBe(409);
      expect(validateFalseSecond.body.activeJob.id).toBe(validateTrueFirst.body.jobId);
    });

    it("rejects non-boolean validate values", async () => {
      const { app } = createManagementJobApiTestApp();
      const stagingDir = makeRealStagingDir("preview-validate-string");
      const res = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir, validate: "false" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("validate must be a boolean");
    });

    it("never silently reuses staging_deploy", async () => {
      const { app } = createManagementJobApiTestApp();
      const stagingDir = makeRealStagingDir("deploy-strict");

      const first = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_deploy", input: { stagingDir, message: "first" } });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_deploy", input: { stagingDir, message: "second" } });
      expect(second.status).toBe(409);
      expect(second.body.activeJob.id).toBe(first.body.jobId);
    });

    it("rejects unknown types, missing fields, and non-object bodies", async () => {
      const { app } = createManagementJobApiTestApp();

      const noType = await request(app).post("/api/management-jobs").send({});
      expect(noType.status).toBe(400);

      const badType = await request(app).post("/api/management-jobs").send({ type: "drop_db" });
      expect(badType.status).toBe(400);
      expect(badType.body.error).toContain("Unsupported management job type");

      const arrayBody = await request(app)
        .post("/api/management-jobs")
        .set("Content-Type", "application/json")
        .send(JSON.stringify([1, 2, 3]));
      expect(arrayBody.status).toBe(400);

      const noStagingDir = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: {} });
      expect(noStagingDir.status).toBe(400);
      expect(noStagingDir.body.error).toContain("stagingDir");

      const missingPath = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_preview", input: { stagingDir: "/no/such/path/here-mgmt-test" } });
      expect(missingPath.status).toBe(400);
      expect(missingPath.body.error).toContain("Staging directory not found");

      const noMessage = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_deploy", input: { stagingDir: makeRealStagingDir("deploy-nomsg") } });
      expect(noMessage.status).toBe(400);
      expect(noMessage.body.error).toContain("message");

      const badInput = await request(app)
        .post("/api/management-jobs")
        .send({ type: "self_update", input: "nope" });
      expect(badInput.status).toBe(400);
    });

    it("rejects enqueue when a restart is pending", async () => {
      const { app } = createManagementJobApiTestApp();
      triggerRestartPending();
      try {
        const res = await request(app).post("/api/management-jobs").send({ type: "self_update" });
        expect(res.status).toBe(409);
        expect(res.body.error).toContain("restart is already pending");
      } finally {
        clearRestartPending();
      }
    });

    it("rejects cross-site mutations", async () => {
      const { app, store } = createManagementJobApiTestApp();

      const res = await request(app)
        .post("/api/management-jobs")
        .set("Host", "localhost:3333")
        .set("Origin", "https://evil.example.test")
        .send({ type: "self_update" });

      expect(res.status).toBe(403);
      expect(store.listActive(["self_update"])).toHaveLength(0);
    });
  });
});
