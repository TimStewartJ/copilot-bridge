import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "./api-routes-test-helpers.js";
import { makeTestDir } from "./helpers.js";
import { createTestApp } from "./test-app.js";
import {
  createManagementJobStore,
  ManagementJobNotCancellableError,
  type ManagementJobStore,
} from "../management-job-store.js";
import { forceClearRestartPending } from "../restart-controller.js";

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
  forceClearRestartPending();
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

  it("degrades cleanly once retention has pruned a job log or its row", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const job = store.enqueue("staging_preview", { stagingDir: "pruned-log" });
    if (!job.logPath) throw new Error("expected job log path");
    writeFileSync(job.logPath, "about to be pruned", "utf-8");
    store.succeed(job.id, {});
    rmSync(job.logPath, { force: true });

    const prunedLog = await request(app).get(`/api/management-jobs/${job.id}/log`);
    expect(prunedLog.status).toBe(200);
    expect(prunedLog.body).toEqual({ jobId: job.id, logTail: "" });

    const detail = await request(app).get(`/api/management-jobs/${job.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.logTail).toBe("");

    const pruned = await store.pruneRetention({
      policy: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxCount: 0 },
      graceMs: 0,
    });
    expect(pruned.deletedJobIds).toEqual([job.id]);

    const prunedRow = await request(app).get(`/api/management-jobs/${job.id}/log`);
    expect(prunedRow.status).toBe(404);
    expect(prunedRow.body.error).toBe("Management job not found.");
  });

  it("returns 409 when queued cancellation loses a status race", async () => {
    const { app, store } = createManagementJobApiTestApp();
    const queued = store.enqueue("staging_preview", { stagingDir: "cancel-race" });
    const cancelSpy = vi.spyOn(store, "cancel").mockImplementationOnce((id) => {
      const claimed = store.claimNext({ runnerPid: 8 });
      if (!claimed || claimed.id !== id) throw new Error("expected queued job to become running");
      throw new ManagementJobNotCancellableError(claimed);
    });

    const response = await request(app).post(`/api/management-jobs/${queued.id}/cancel`);

    expect(cancelSpy).toHaveBeenCalledWith(queued.id, "Cancelled from Management Jobs UI.");
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Cannot cancel running management jobs.");
    expect(response.body.job.status).toBe("running");
    expect(store.get(queued.id)).toMatchObject({
      status: "running",
      cancelRequestedAt: undefined,
    });
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

  it("rejects restart-capable management mutations from staging previews", async () => {
    const { app, store, ctx } = createManagementJobApiTestApp();
    ctx.isStaging = true;

    const enqueue = await request(app)
      .post("/api/management-jobs")
      .send({ type: "self_update" });
    expect(enqueue.status).toBe(404);
    expect(store.listActive(["self_update"])).toHaveLength(0);

    const job = store.enqueue("self_update", {});
    const cancel = await request(app).post(`/api/management-jobs/${job.id}/cancel`);
    expect(cancel.status).toBe(404);
    expect(store.get(job.id)?.status).toBe("queued");

    store.fail(job.id, "boom");
    const retry = await request(app).post(`/api/management-jobs/${job.id}/retry`);
    expect(retry.status).toBe(404);
    expect(store.listActive(["self_update"])).toHaveLength(0);
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

    it("reuses an active staging_preview job when stagingDir and validate match", async () => {
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

    it("queues distinct deploy worktrees but rejects duplicates", async () => {
      const { app } = createManagementJobApiTestApp();
      const firstDir = makeRealStagingDir("deploy-first");
      const secondDir = makeRealStagingDir("deploy-second");

      const first = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_deploy", input: { stagingDir: firstDir, message: "first" } });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_deploy", input: { stagingDir: secondDir, message: "second" } });
      expect(second.status).toBe(201);

      const duplicate = await request(app)
        .post("/api/management-jobs")
        .send({ type: "staging_deploy", input: { stagingDir: firstDir, message: "duplicate" } });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.activeJob.id).toBe(first.body.jobId);
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

    it("allows previews and deploys but rejects self-update when a restart is queued by another process", async () => {
      const { app, ctx } = createManagementJobApiTestApp();
      const dataDir = ctx.runtimePaths?.dataDir;
      if (!dataDir) throw new Error("test app is missing runtime data dir");
      const signalFile = join(dataDir, "restart.signal");

      // The management-job runner is a separate process: it triggers the
      // restart the server gets restarted by, so only the on-disk record can
      // tell the server a cutover is queued.
      writeFileSync(signalFile, "{}");
      try {
        const update = await request(app).post("/api/management-jobs").send({ type: "self_update" });
        expect(update.status).toBe(409);
        expect(update.body.error).toContain("restart is already pending");

        const previewDir = makeRealStagingDir("preview-during-restart");
        const preview = await request(app)
          .post("/api/management-jobs")
          .send({ type: "staging_preview", input: { stagingDir: previewDir } });
        expect(preview.status).toBe(201);

        const stagingDir = makeRealStagingDir("deploy-during-restart");
        const deploy = await request(app)
          .post("/api/management-jobs")
          .send({ type: "staging_deploy", input: { stagingDir, message: "later" } });
        expect(deploy.status).toBe(201);
      } finally {
        rmSync(signalFile, { force: true });
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
