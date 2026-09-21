import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDatabase } from "../db.js";
import {
  ActiveManagementJobError,
  createManagementJobStore,
  ManagementJobNotCancellableError,
  type ManagementJob,
} from "../management-job-store.js";
import { RETENTION_DAY_MS } from "../log-retention.js";
import {
  ManagementJobExecutionError,
  type ManagementJobDispatchOptions,
} from "../management-job-dispatch.js";
import {
  runClaimedManagementJob,
  runManagementJobRunnerLoop,
} from "../../management-job-runner.js";
import { requestRestart, readPendingRestartSignal } from "../restart-signal.js";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { createStagingToolDefinitions } from "../staging-tools.js";
import { registerManagementJobTools } from "../tools/management-job-tools.js";
import { makeTestDir } from "./helpers.js";

function testDataDir(name: string): string {
  return makeTestDir(`management-jobs-${name}`);
}

function createStore(name: string, now: () => Date = () => new Date()) {
  const dataDir = testDataDir(name);
  const db = openMemoryDatabase();
  const store = createManagementJobStore(db, { dataDir, now });
  return { db, store, dataDir };
}

const RETENTION_START_MS = Date.parse("2026-05-18T20:00:00.000Z");
const RETENTION_NOW_MS = RETENTION_START_MS + 60 * RETENTION_DAY_MS;

function seedJobLog(job: ManagementJob, writtenAt: Date): string {
  const logPath = job.logPath;
  if (!logPath) throw new Error("expected enqueued job to have a log path");
  writeFileSync(logPath, `log for ${job.id}`);
  utimesSync(logPath, writtenAt, writtenAt);
  return logPath;
}

describe("management job store", () => {
  it("enqueues, claims, heartbeats, and completes jobs transactionally", () => {
    let current = new Date("2026-05-18T20:00:00.000Z");
    const { db, store, dataDir } = createStore("transitions", () => current);
    try {
      const job = store.enqueue("self_update", { source: "test" });
      expect(job.status).toBe("queued");
      expect(job.logPath).toContain(dataDir);

      expect(() => store.enqueue("staging_deploy", { stagingDir: "x" })).toThrow(ActiveManagementJobError);
      const preview = store.enqueue("staging_preview", { stagingDir: "preview" });
      expect(preview.status).toBe("queued");
      expect(() => store.enqueue("staging_preview", { stagingDir: "preview" })).toThrow(ActiveManagementJobError);
      expect(store.enqueue("staging_preview", { stagingDir: "other-preview" }).status).toBe("queued");

      const claimed = store.claimNext({ runnerPid: 101 });
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.status).toBe("running");
      expect(claimed?.runnerPid).toBe(101);

      current = new Date("2026-05-18T20:00:01.000Z");
      store.heartbeat(job.id, 101);
      expect(store.get(job.id)?.heartbeatAt).toBe(current.toISOString());

      const completed = store.succeed(job.id, { ok: true });
      expect(completed.status).toBe("succeeded");
      expect(completed.result).toEqual({ ok: true });
      expect(store.listActive(["self_update", "staging_deploy"])).toEqual([]);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reclaims stale running jobs", () => {
    let current = new Date("2026-05-18T20:00:00.000Z");
    const { db, store, dataDir } = createStore("stale", () => current);
    try {
      const job = store.enqueue("staging_preview", {});
      expect(store.claimNext({ runnerPid: 1 })?.id).toBe(job.id);
      current = new Date("2026-05-18T20:05:00.000Z");
      const reclaimed = store.claimNext({ runnerPid: 2, staleAfterMs: 1_000 });
      expect(reclaimed?.id).toBe(job.id);
      expect(reclaimed?.runnerPid).toBe(2);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("claims only requested job types", () => {
    const { db, store, dataDir } = createStore("claim-types");
    try {
      const update = store.enqueue("self_update", {});
      const preview = store.enqueue("staging_preview", { stagingDir: "preview" });

      expect(store.claimNext({ types: ["staging_preview"] })?.id).toBe(preview.id);
      expect(store.get(update.id)?.status).toBe("queued");
      expect(store.claimNext({ types: [] })).toBeNull();
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("queues distinct deploy worktrees and reserves each until activation", () => {
    const { db, store, dataDir } = createStore("deploy-queue");
    try {
      const first = store.enqueue("staging_deploy", { stagingDir: join(dataDir, "a"), message: "a" });
      const second = store.enqueue("staging_deploy", { stagingDir: join(dataDir, "b"), message: "b" });
      expect(store.listActive(["staging_deploy"])).toHaveLength(2);
      expect(() => store.enqueue("staging_deploy", {
        stagingDir: join(dataDir, "a"),
        message: "duplicate",
      })).toThrow(ActiveManagementJobError);

      store.succeed(first.id, {
        restartDeferred: true,
        releaseCandidate: {
          id: "release-a",
          root: join(dataDir, "release-a"),
          commitSha: "commit-a",
          source: "staging_deploy",
          dependencyHash: "deps-a",
        },
      });
      expect(() => store.enqueue("staging_deploy", {
        stagingDir: join(dataDir, "a"),
        message: "still reserved",
      })).toThrow(ActiveManagementJobError);
      expect(store.claimNextDeploy()?.id).toBe(second.id);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("cancels queued jobs with terminal cancellation metadata", () => {
    let current = new Date("2026-05-18T20:00:00.000Z");
    const { db, store, dataDir } = createStore("cancel-queued", () => current);
    try {
      const job = store.enqueue("staging_preview", { stagingDir: "queued" });
      current = new Date("2026-05-18T20:00:01.000Z");

      const cancelled = store.cancel(job.id, "Cancelled by test.");

      expect(cancelled).toMatchObject({
        status: "cancelled",
        error: "Cancelled by test.",
        cancelRequestedAt: current.toISOString(),
        completedAt: current.toISOString(),
        updatedAt: current.toISOString(),
      });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects running and terminal cancellation without mutating jobs", () => {
    let current = new Date("2026-05-18T20:00:00.000Z");
    const { db, store, dataDir } = createStore("cancel-non-queued", () => current);
    try {
      const running = store.enqueue("staging_preview", { stagingDir: "running" });
      expect(store.claimNext({ runnerPid: 7 })?.id).toBe(running.id);
      const runningBefore = store.get(running.id);

      const terminal = store.enqueue("staging_preview", { stagingDir: "terminal" });
      store.fail(terminal.id, "terminal");
      const terminalBefore = store.get(terminal.id);

      current = new Date("2026-05-18T20:00:01.000Z");
      expect(() => store.cancel(running.id)).toThrow(ManagementJobNotCancellableError);
      expect(() => store.cancel(terminal.id)).toThrow(ManagementJobNotCancellableError);
      expect(store.get(running.id)).toEqual(runningBefore);
      expect(store.get(terminal.id)).toEqual(terminalBefore);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("lists jobs with filters, limits, and newest-first ordering", () => {
    let current = new Date("2026-05-18T20:00:00.000Z");
    const { db, store, dataDir } = createStore("list-filters", () => current);
    try {
      const first = store.enqueue("staging_preview", { index: 1 });
      current = new Date("2026-05-18T20:00:01.000Z");
      const cancelled = store.enqueue("staging_deploy", { index: 2 });
      store.cancel(cancelled.id);
      current = new Date("2026-05-18T20:00:02.000Z");
      const failed = store.enqueue("self_update", { index: 3 });
      store.fail(failed.id, "boom");

      expect(store.list().map((job) => job.id)).toEqual([failed.id, cancelled.id, first.id]);
      expect(store.list({ order: "created-asc" }).map((job) => job.id)).toEqual([first.id, cancelled.id, failed.id]);
      expect(store.list({ types: ["staging_preview"] }).map((job) => job.id)).toEqual([first.id]);
      expect(store.list({ statuses: ["cancelled"] }).map((job) => job.id)).toEqual([cancelled.id]);
      expect(store.list({ types: ["self_update"], statuses: ["failed"] }).map((job) => job.id)).toEqual([failed.id]);
      expect(store.list({ limit: 2 }).map((job) => job.id)).toEqual([failed.id, cancelled.id]);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("applies default and maximum list limits", () => {
    const { db, store, dataDir } = createStore("list-limit");
    try {
      for (let index = 0; index < 205; index += 1) {
        store.enqueue("staging_preview", { index });
      }

      expect(store.list()).toHaveLength(50);
      expect(store.list({ limit: 500 })).toHaveLength(200);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("prunes aged and excess terminal jobs with their logs but never active ones", async () => {
    let current = new Date(RETENTION_START_MS);
    const { db, store, dataDir } = createStore("retention", () => current);
    try {
      const succeedAt = (label: string, at: number): ManagementJob => {
        current = new Date(at);
        const job = store.enqueue("staging_preview", { stagingDir: label });
        seedJobLog(job, current);
        store.succeed(job.id, { label });
        return job;
      };

      const agedFirst = succeedAt("aged-1", RETENTION_START_MS);
      const agedSecond = succeedAt("aged-2", RETENTION_START_MS + 60_000);
      const excess = succeedAt("recent-1", RETENTION_NOW_MS - 180_000);
      const keptOlder = succeedAt("recent-2", RETENTION_NOW_MS - 120_000);
      const keptNewest = succeedAt("recent-3", RETENTION_NOW_MS - 60_000);

      current = new Date(RETENTION_START_MS);
      const running = store.enqueue("staging_preview", { stagingDir: "running" });
      seedJobLog(running, current);
      expect(store.claimNext({ runnerPid: 11 })?.id).toBe(running.id);
      const queued = store.enqueue("self_update", { source: "test" });
      seedJobLog(queued, current);

      const result = await store.pruneRetention({
        policy: { maxAgeMs: 30 * RETENTION_DAY_MS, maxCount: 2 },
        nowMs: RETENTION_NOW_MS,
        graceMs: 0,
      });

      expect([...result.deletedJobIds].sort())
        .toEqual([agedFirst.id, agedSecond.id, excess.id].sort());
      expect(result.failedLogDeletions).toBe(0);
      for (const job of [agedFirst, agedSecond, excess]) {
        expect(store.get(job.id)).toBeNull();
        expect(existsSync(job.logPath as string)).toBe(false);
      }

      for (const job of [keptOlder, keptNewest, running, queued]) {
        expect(store.get(job.id)).not.toBeNull();
        expect(existsSync(job.logPath as string)).toBe(true);
      }
      expect(store.get(running.id)?.status).toBe("running");
      expect(store.get(queued.id)?.status).toBe("queued");
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("sweeps orphan log files while keeping referenced and freshly written ones", async () => {
    let current = new Date(RETENTION_NOW_MS - 60_000);
    const { db, store, dataDir } = createStore("retention-orphans", () => current);
    try {
      const job = store.enqueue("staging_preview", { stagingDir: "kept" });
      seedJobLog(job, new Date(RETENTION_START_MS));
      store.succeed(job.id, {});

      const logDir = join(dataDir, "management-jobs", "logs");
      const agedOrphan = join(logDir, "aged-orphan.log");
      const freshOrphan = join(logDir, "fresh-orphan.log");
      const notALog = join(logDir, "orphan.txt");
      for (const path of [agedOrphan, freshOrphan, notALog]) {
        writeFileSync(path, "orphan");
      }
      const aged = new Date(RETENTION_START_MS);
      utimesSync(agedOrphan, aged, aged);
      utimesSync(notALog, aged, aged);
      utimesSync(freshOrphan, current, current);

      const result = await store.pruneRetention({
        policy: { maxAgeMs: RETENTION_DAY_MS, maxCount: 200 },
        nowMs: RETENTION_NOW_MS,
      });

      expect(result.deletedJobIds).toEqual([]);
      expect(result.deletedLogPaths).toEqual([agedOrphan]);
      expect(existsSync(freshOrphan)).toBe(true);
      expect(existsSync(notALog)).toBe(true);
      expect(existsSync(job.logPath as string)).toBe(true);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("retries a log left behind when its row was pruned in an earlier pass", async () => {
    let current = new Date(RETENTION_START_MS);
    const { db, store, dataDir } = createStore("retention-orphan-retry", () => current);
    try {
      const job = store.enqueue("staging_preview", { stagingDir: "left-behind" });
      const logPath = seedJobLog(job, new Date(RETENTION_START_MS));
      store.succeed(job.id, {});

      // First pass deletes the row but the log is still inside the grace window.
      const first = await store.pruneRetention({
        policy: { maxAgeMs: RETENTION_DAY_MS, maxCount: 200 },
        nowMs: RETENTION_NOW_MS,
        graceMs: 90 * RETENTION_DAY_MS,
      });
      expect(first.deletedJobIds).toEqual([job.id]);
      expect(first.deletedLogPaths).toEqual([]);
      expect(existsSync(logPath)).toBe(true);

      const second = await store.pruneRetention({
        policy: { maxAgeMs: RETENTION_DAY_MS, maxCount: 200 },
        nowMs: RETENTION_NOW_MS,
        graceMs: 0,
      });
      expect(second.deletedJobIds).toEqual([]);
      expect(second.deletedLogPaths).toEqual([logPath]);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("never deletes a log path outside the store log directory", async () => {
    let current = new Date(RETENTION_START_MS);
    const { db, store, dataDir } = createStore("retention-foreign-log", () => current);
    try {
      const job = store.enqueue("staging_preview", { stagingDir: "foreign" });
      store.succeed(job.id, {});
      const foreignLog = join(dataDir, "not-a-job-log.log");
      writeFileSync(foreignLog, "keep me");
      utimesSync(foreignLog, new Date(RETENTION_START_MS), new Date(RETENTION_START_MS));
      db.prepare("UPDATE management_jobs SET logPath = ? WHERE id = ?").run(foreignLog, job.id);

      const result = await store.pruneRetention({
        policy: { maxAgeMs: RETENTION_DAY_MS, maxCount: 200 },
        nowMs: RETENTION_START_MS + 60 * RETENTION_DAY_MS,
        graceMs: 0,
      });

      expect(result.deletedJobIds).toEqual([job.id]);
      expect(result.deletedLogPaths).toEqual([]);
      expect(existsSync(foreignLog)).toBe(true);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("management job runner", () => {
  function release(dataDir: string, index: number) {
    return { id: `release-${index}`, root: join(dataDir, `release-${index}`), commitSha: `commit-${index}`,
      source: "staging_deploy", dependencyHash: `deps-${index}` };
  }

  it("keeps running every kind of job while a restart is pending", async () => {
    const { db, store, dataDir } = createStore("runner-nonblocking");
    try {
      const update = store.enqueue("self_update", {});
      const preview = store.enqueue("staging_preview", { stagingDir: "preview" });
      await requestRestart(dataDir, { validationMode: "operational", source: "test" });
      const processed: string[] = [];
      const prune = vi.spyOn(store, "pruneRetention");
      await runManagementJobRunnerLoop({
        store, deployBatchDataDir: dataDir, pollIntervalMs: 1, log: () => {},
        shouldStop: () => processed.length === 2,
        dispatch: async (job) => { processed.push(job.id); return { success: true }; },
      });
      expect(processed).toEqual([update.id, preview.id]);
      expect(store.get(update.id)?.status).toBe("succeeded");
      expect(store.get(preview.id)?.status).toBe("succeeded");
      expect(prune).toHaveBeenCalledTimes(2);
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("recognizes an activated self-update that includes the pending deploy", async () => {
    const { db, store, dataDir } = createStore("superseding-self-update");
    try {
      const deploy = store.enqueue("staging_deploy", { stagingDir: "worktree" });
      store.succeed(deploy.id, { restartQueued: true, releaseCandidate: release(dataDir, 1) });
      const included = vi.fn(async () => true);
      let stopping = false;
      await runManagementJobRunnerLoop({
        store, deployBatchDataDir: dataDir, pollIntervalMs: 1, log: () => {},
        shouldStop: () => stopping, isCommitIncluded: included, cleanupDeploy: async () => {},
        getActiveRelease: () => { stopping = true; return release(dataDir, 2); },
      });
      expect(included).toHaveBeenCalledWith("commit-1", "commit-2");
      expect(store.get(deploy.id)?.result).toMatchObject({ restartActivated: true });
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("keeps FIFO job admission and joins deployments to the same pending restart", async () => {
    const { db, store, dataDir } = createStore("runner-fifo-deploys");
    try {
      const first = store.enqueue("staging_deploy", { stagingDir: join(dataDir, "first") });
      const preview = store.enqueue("staging_preview", { stagingDir: "preview" });
      const second = store.enqueue("staging_deploy", { stagingDir: join(dataDir, "second") });
      const initial = await requestRestart(dataDir, { validationMode: "operational", source: "self_restart" });
      const processed: string[] = [];
      await runManagementJobRunnerLoop({
        store, deployBatchDataDir: dataDir, pollIntervalMs: 1, log: () => {},
        shouldStop: () => processed.length === 3,
        dispatch: async (job, options) => {
          processed.push(job.id);
          if (job.type !== "staging_deploy") return { success: true };
          expect(options.deferDeployRestart).toBe(true);
          return { restartDeferred: true, releaseCandidate: release(dataDir, job.id === first.id ? 1 : 2) };
        },
        getActiveRelease: () => null,
      });
      expect(processed).toEqual([first.id, preview.id, second.id]);
      await expect(readPendingRestartSignal(dataDir)).resolves.toMatchObject({ requestId: initial.requestId,
        requestedAt: initial.requestedAt, releaseCandidate: release(dataDir, 2) });
      expect(store.get(second.id)?.result).toMatchObject({ restartQueued: true, deployBatchSize: 2 });
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("does not cap a pending deployment batch and confirms all jobs after activation", async () => {
    const { db, store, dataDir } = createStore("runner-unbounded-batch");
    try {
      const jobs = Array.from({ length: 12 }, (_, index) => store.enqueue("staging_deploy", {
        stagingDir: join(dataDir, `deploy-${index}`), message: `deploy ${index}`,
      }));
      let processed = 0;
      await runManagementJobRunnerLoop({
        store, deployBatchDataDir: dataDir, pollIntervalMs: 1, log: () => {},
        shouldStop: () => processed === jobs.length,
        dispatch: async () => ({ restartDeferred: true, releaseCandidate: release(dataDir, ++processed) }),
        getActiveRelease: () => null,
      });
      expect(processed).toBe(12);
      expect(store.listActive()).toEqual([]);
      expect(store.listDeploysAwaitingActivation()).toHaveLength(12);
      const newest = release(dataDir, 12);
      await expect(readPendingRestartSignal(dataDir)).resolves.toMatchObject({ releaseCandidate: newest });
      let confirmed = false;
      const cleanupDeploy = vi.fn(async () => {});
      await runManagementJobRunnerLoop({
        store, deployBatchDataDir: dataDir, pollIntervalMs: 1, log: () => {}, cleanupDeploy,
        shouldStop: () => confirmed,
        getActiveRelease: () => { confirmed = true; return newest; },
      });
      expect(cleanupDeploy).toHaveBeenCalledTimes(12);
      expect(store.listDeploysAwaitingActivation()).toEqual([]);
      for (const job of jobs) expect(store.get(job.id)?.result).toMatchObject({ restartActivated: true });
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("waits between idle reconciliation checks rather than spinning while activation is pending", async () => {
    const { db, store, dataDir } = createStore("runner-pending-poll");
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const deploy = store.enqueue("staging_deploy", { stagingDir: join(dataDir, "deploy") });
      store.succeed(deploy.id, { restartQueued: true, releaseCandidate: release(dataDir, 1) });
      await requestRestart(dataDir, { validationMode: "deploy", source: "staging_deploy_batch", releaseCandidate: release(dataDir, 1) });
      let checks = 0;
      await runManagementJobRunnerLoop({
        store, deployBatchDataDir: dataDir, pollIntervalMs: 7, log: () => {},
        shouldStop: () => checks === 3,
        getActiveRelease: () => { checks++; return null; },
      });
      expect(store.get(deploy.id)?.result).toMatchObject({ restartQueued: true });
      expect(timers.mock.calls.filter(([, delay]) => delay === 7)).toHaveLength(3);
    } finally { timers.mockRestore(); db.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("finds pending deploys behind more than 200 terminal jobs", () => {
    const { db, store, dataDir } = createStore("pending-deploy-query");
    try {
      for (let index = 0; index < 205; index++) store.succeed(store.enqueue("staging_preview", {}).id);
      const deploy = store.enqueue("staging_deploy", { stagingDir: "latest" });
      store.succeed(deploy.id, { restartDeferred: true, releaseCandidate: release(dataDir, 1) });
      expect(store.listDeploysAwaitingActivation().map((job) => job.id)).toEqual([deploy.id]);
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  it("dispatches a claimed job and stores success or failure", async () => {
    const success = createStore("runner-success");
    try {
      const job = success.store.enqueue("staging_preview", {});
      const claimed = success.store.claimNext({ runnerPid: 123 });
      if (!claimed) throw new Error("expected claimed job");
      await runClaimedManagementJob(success.store, claimed, {
        heartbeatIntervalMs: 10,
        log: () => {},
        dispatch: async (_job, _options: ManagementJobDispatchOptions) => ({ success: true, previewPath: "/staging/x/" }),
      });

      expect(success.store.get(job.id)).toMatchObject({
        status: "succeeded",
        result: { success: true, previewPath: "/staging/x/" },
      });
    } finally {
      success.db.close();
      rmSync(success.dataDir, { recursive: true, force: true });
    }

    const failure = createStore("runner-failure");
    try {
      const job = failure.store.enqueue("staging_preview", {});
      const claimed = failure.store.claimNext({ runnerPid: 123 });
      if (!claimed) throw new Error("expected claimed job");
      await runClaimedManagementJob(failure.store, claimed, {
        heartbeatIntervalMs: 10,
        log: () => {},
        dispatch: async () => {
          throw new ManagementJobExecutionError("preview failed", { resultType: "failure" });
        },
      });
      expect(failure.store.get(job.id)).toMatchObject({
        status: "failed",
        error: "preview failed",
        result: { resultType: "failure" },
      });
    } finally {
      failure.db.close();
      rmSync(failure.dataDir, { recursive: true, force: true });
    }
  });

});

describe("management job status tool", () => {
  it("surfaces terminal and next-action contracts in tool text", async () => {
    const { db, store, dataDir } = createStore("status-tool");
    try {
      const ctx = { managementJobStore: store, runtimePaths: { dataDir } } as any;
      const server = new BridgeToolsMcpServer(ctx);
      registerManagementJobTools(server, ctx);
      const tool = (server as any).tools.get("management_job_status");
      const job = store.enqueue("staging_preview", { stagingDir: join(dataDir, "staging") });

      const queued = await tool.handler({ jobId: job.id }, {} as any);
      expect(queued).toMatchObject({
        success: true,
        terminal: false,
        toolNextAction: "wait",
      });
      expect(queued.content[0].text).toContain('"terminal":false');
      expect(queued.content[0].text).toContain('"nextAction":"wait"');
      expect(queued.content[0].text).toContain("same-session defer");
      expect(queued.content[0].text).not.toContain("intervalSeconds");
      expect(queued.content[0].text).not.toContain("Do not call management_job_status synchronously just to poll.");

      store.succeed(job.id, { success: true, previewUrl: "https://bridge.example/staging/x/" });
      const succeeded = await tool.handler({ jobId: job.id }, {} as any);
      expect(succeeded).toMatchObject({
        success: true,
        terminal: true,
        toolNextAction: "proceed",
      });
      expect(succeeded.content[0].text).toContain("https://bridge.example/staging/x/");
      expect(succeeded.content[0].text).toContain('"nextAction":"proceed"');

      const failedPreview = store.enqueue("staging_preview", { stagingDir: join(dataDir, "failed-staging") });
      store.fail(failedPreview.id, "Preview build failed.");
      const failed = await tool.handler({ jobId: failedPreview.id }, {} as any);
      expect(failed).toMatchObject({
        success: true,
        terminal: true,
        toolNextAction: "respond",
      });

      const cancelledPreview = store.enqueue("staging_preview", { stagingDir: join(dataDir, "cancelled-staging") });
      store.cancel(cancelledPreview.id);
      const cancelled = await tool.handler({ jobId: cancelledPreview.id }, {} as any);
      expect(cancelled).toMatchObject({
        success: true,
        terminal: true,
        toolNextAction: "respond",
      });

      const deploy = store.enqueue("staging_deploy", { stagingDir: join(dataDir, "deploy"), message: "Deploy" });
      store.succeed(deploy.id, {
        success: true,
        commitSha: "abc123",
        restartQueued: true,
        restartActivated: false,
        releaseCandidate: {
          id: "release",
          root: join(dataDir, "release"),
          commitSha: "abc123",
          source: "staging_deploy",
          dependencyHash: "deps",
        },
      });
      const awaiting = await tool.handler({ jobId: deploy.id }, {} as any);
      expect(awaiting).toMatchObject({ terminal: false, toolNextAction: "wait" });
      store.succeed(deploy.id, { success: true, commitSha: "abc123", restartActivated: true });
      const deployed = await tool.handler({ jobId: deploy.id }, {} as any);
      expect(deployed).toMatchObject({
        success: true,
        terminal: true,
        toolNextAction: "respond",
      });

      const update = store.enqueue("self_update", {});
      store.succeed(update.id, { success: true, commitSha: "def456" });
      const updated = await tool.handler({ jobId: update.id }, {} as any);
      expect(updated).toMatchObject({
        success: true,
        terminal: true,
        toolNextAction: "respond",
      });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("staging management tool enqueue", () => {
  it("queues preview and deploy without running heavy staging flows", async () => {
    const { db, store, dataDir } = createStore("staging-tools");
    const stagingDir = join(dataDir, "worktree");
    mkdirSync(stagingDir, { recursive: true });
    try {
      const ctx = { managementJobStore: store } as any;
      const tools = createStagingToolDefinitions(ctx);
      const preview = tools.find((tool) => tool.name === "staging_preview");
      const deploy = tools.find((tool) => tool.name === "staging_deploy");
      if (!preview?.handler || !deploy?.handler) throw new Error("missing staging tools");

      const previewResult = await preview.handler({ stagingDir, validate: false }, {} as any) as any;
      expect(previewResult).toMatchObject({ success: true, status: "queued" });
      expect(previewResult).toMatchObject({ terminal: false, toolNextAction: "proceed" });
      expect(previewResult.message).toContain("same-session defer");
      expect(previewResult.message).not.toContain("intervalSeconds");
      expect(previewResult.message).not.toContain("management_job_status");
      expect(previewResult.content[0].text).toContain('"nextAction":"proceed"');
      expect(store.get(previewResult.jobId)).toMatchObject({
        type: "staging_preview",
        input: { stagingDir, validate: false },
      });

      const deployResult = await deploy.handler({ stagingDir, message: "Ship it" }, {} as any) as any;
      expect(deployResult).toMatchObject({ success: true, status: "queued" });
      expect(deployResult).toMatchObject({ terminal: false, toolNextAction: "proceed" });
      expect(deployResult.message).toContain("same-session defer");
      expect(deployResult.message).not.toContain("intervalSeconds");
      expect(deployResult.message).not.toContain("management_job_status");
      expect(deployResult.message).not.toContain("Do not call management_job_status synchronously just to poll.");
      expect(deployResult.message).not.toContain("restart cutover is not blocked");
      expect(store.get(deployResult.jobId)).toMatchObject({
        type: "staging_deploy",
        input: { stagingDir, message: "Ship it" },
      });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
