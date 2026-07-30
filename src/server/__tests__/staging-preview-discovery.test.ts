import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTestDir } from "./helpers.js";
import { openDatabase, type DatabaseSync } from "../db.js";
import {
  createManagementJobStore,
  type ManagementJob,
  type ManagementJobStatus,
  type ManagementJobStore,
  type ManagementJobType,
} from "../management-job-store.js";
import {
  createStagingPreviewDiscovery,
  type StagingPreviewDiscoveryTrigger,
} from "../staging-preview-discovery.js";

const POLL_INTERVAL_MS = 1_000;

function createJob(overrides: Partial<ManagementJob> = {}): ManagementJob {
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  return {
    id: "job-1",
    type: "staging_preview" as ManagementJobType,
    status: "queued" as ManagementJobStatus,
    input: { stagingDir: join("staging", "abc123"), validate: true },
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function createFakeStore(jobs: ManagementJob[] = []): ManagementJobStore & {
  setJob(job: ManagementJob | null): void;
  failNextGet(error: Error): void;
  getCalls: number;
} {
  const rows = new Map<string, ManagementJob>(jobs.map((job) => [job.id, job]));
  let pendingGetError: Error | null = null;
  const store = {
    getCalls: 0,
    setJob(job: ManagementJob | null): void {
      if (!job) {
        rows.clear();
        return;
      }
      rows.set(job.id, job);
    },
    failNextGet(error: Error): void {
      pendingGetError = error;
    },
    get(id: string): ManagementJob | null {
      store.getCalls++;
      if (pendingGetError) {
        const error = pendingGetError;
        pendingGetError = null;
        throw error;
      }
      return rows.get(id) ?? null;
    },
    listActive(types?: readonly ManagementJobType[]): ManagementJob[] {
      return [...rows.values()].filter((job) =>
        (job.status === "queued" || job.status === "running")
        && (!types || types.includes(job.type)));
    },
  } as unknown as ManagementJobStore & {
    setJob(job: ManagementJob | null): void;
    failNextGet(error: Error): void;
    getCalls: number;
  };
  return store;
}

function createDiscoverySpy() {
  const triggers: StagingPreviewDiscoveryTrigger[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let resolveGate: (() => void) | null = null;

  const discover = vi.fn(async (trigger: StagingPreviewDiscoveryTrigger) => {
    triggers.push(trigger);
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (resolveGate) {
      await new Promise<void>((resolve) => {
        const previous = resolveGate;
        resolveGate = () => {
          previous?.();
          resolve();
        };
      });
    }
    concurrent--;
  });

  return {
    discover,
    triggers,
    get maxConcurrent() {
      return maxConcurrent;
    },
    hold(): void {
      resolveGate = () => {};
    },
    release(): void {
      const gate = resolveGate;
      resolveGate = null;
      gate?.();
    },
  };
}

describe("staging preview discovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves no timer running when boot finds no active jobs", () => {
    const store = createFakeStore();
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.resumeActiveJobs();

    expect(controller.watchedJobIds()).toEqual([]);
    expect(controller.hasScheduledWork()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(spy.discover).not.toHaveBeenCalled();
    controller.stop();
  });

  it("registers previews when a watched job completes, then stops all timers", async () => {
    const job = createJob({ status: "queued" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.watchJob(job);
    expect(vi.getTimerCount()).toBe(1);

    store.setJob({ ...job, status: "running", heartbeatAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(spy.discover).not.toHaveBeenCalled();
    expect(controller.watchedJobIds()).toEqual([job.id]);

    store.setJob({ ...job, status: "succeeded", completedAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(spy.triggers[0].reason).toBe("job-completed");
    expect(spy.triggers[0].completedJobs.map((entry) => entry.id)).toEqual([job.id]);

    // Nothing is watched any more, so no discovery work remains scheduled.
    expect(controller.watchedJobIds()).toEqual([]);
    expect(controller.hasScheduledWork()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 20);
    expect(spy.discover).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("resumes jobs a previous process left active and discovers on completion", async () => {
    const job = createJob({ id: "resumed-job", status: "running", heartbeatAt: new Date().toISOString() });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.resumeActiveJobs();
    expect(controller.watchedJobIds()).toEqual(["resumed-job"]);

    store.setJob({ ...job, status: "failed" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("ignores job types that cannot change preview artifacts", () => {
    const store = createFakeStore();
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.watchJob(createJob({ id: "update-job", type: "self_update" }));
    controller.watchJob(createJob({ id: "already-done", status: "succeeded" }));

    expect(controller.watchedJobIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("watches staging_deploy jobs so removed preview dists are unregistered", async () => {
    const job = createJob({ id: "deploy-job", type: "staging_deploy", status: "running" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.watchJob(job);
    store.setJob({ ...job, status: "succeeded" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(spy.triggers[0].completedJobs[0].type).toBe("staging_deploy");
    controller.stop();
  });

  it("keeps watching a stalled job because the runner can still reclaim it", async () => {
    const startedAt = new Date().toISOString();
    const job = createJob({ status: "running", heartbeatAt: startedAt, startedAt });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      staleHeartbeatMs: 5_000,
    });

    controller.watchJob(job);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6);

    // One defensive rescan for the stall, but the job is still being watched.
    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(spy.triggers[0].reason).toBe("job-stalled");
    expect(spy.triggers[0].completedJobs).toEqual([]);
    expect(controller.watchedJobIds()).toEqual([job.id]);

    // A reclaiming runner refreshes the heartbeat and later succeeds.
    store.setJob({ ...job, status: "running", heartbeatAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(spy.discover).toHaveBeenCalledTimes(1);

    store.setJob({ ...job, status: "succeeded" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(2);
    expect(spy.triggers[1].reason).toBe("job-completed");
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("stops watching a claimed job whose row goes idle", async () => {
    const frozen = new Date().toISOString();
    const job = createJob({ status: "running", heartbeatAt: frozen, startedAt: frozen });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxIdleWatchMs: 3_000,
      staleHeartbeatMs: 60_000,
    });

    controller.watchJob(job);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);

    expect(controller.watchedJobIds()).toEqual([]);
    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(spy.triggers[0].reason).toBe("watch-expired");
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("keeps watching a job queued behind other work past the idle window", async () => {
    const job = createJob({ status: "queued" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxIdleWatchMs: 3_000,
      maxTotalWatchMs: 12 * 60 * 60_000,
    });

    controller.watchJob(job);
    // A queued row has no writer, so a long wait behind a deploy must not expire it.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    expect(controller.watchedJobIds()).toEqual([job.id]);
    expect(spy.discover).not.toHaveBeenCalled();

    store.setJob({ ...job, status: "succeeded", updatedAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(spy.triggers[0].reason).toBe("job-completed");
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("stops watching a job that is never claimed once the maximum window elapses", async () => {
    const job = createJob({ status: "queued" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxIdleWatchMs: 60 * 60_000,
      maxTotalWatchMs: 3_000,
    });

    controller.watchJob(job);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);

    expect(controller.watchedJobIds()).toEqual([]);
    expect(spy.triggers[0].reason).toBe("watch-expired");
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("keeps watching a job whose row is already hours old when the server adopts it", async () => {
    const stale = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const job = createJob({
      status: "running",
      createdAt: stale,
      updatedAt: stale,
      startedAt: stale,
      heartbeatAt: stale,
    });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxIdleWatchMs: 60 * 60_000,
      // Both windows are shorter than the row's age: only adoption-anchored
      // windows can keep this job watched.
      maxTotalWatchMs: 60 * 60_000,
      staleHeartbeatMs: 5 * 60_000,
    });

    controller.resumeActiveJobs();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(controller.watchedJobIds()).toEqual([job.id]);
    expect(spy.triggers.map((trigger) => trigger.reason)).toEqual(["job-stalled"]);

    // The runner reclaims the stale job and finishes it.
    store.setJob({ ...job, status: "succeeded", updatedAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.triggers.at(-1)?.reason).toBe("job-completed");
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("keeps watching a job claimed just before the maximum queued window elapses", async () => {
    const job = createJob({ status: "queued" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxIdleWatchMs: 60 * 60_000,
      maxTotalWatchMs: 3_000,
    });

    controller.watchJob(job);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    // Claimed right at the ceiling: the queue bound must not drop a running job.
    store.setJob({
      ...job,
      status: "running",
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(controller.watchedJobIds()).toEqual([job.id]);
    expect(spy.discover).not.toHaveBeenCalled();

    store.setJob({ ...job, status: "succeeded", updatedAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(spy.triggers[0].reason).toBe("job-completed");
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("extends the idle window while the runner keeps updating the job row", async () => {
    const job = createJob({ status: "running", heartbeatAt: new Date().toISOString() });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxIdleWatchMs: 3_000,
      staleHeartbeatMs: 5 * 60_000,
    });

    controller.watchJob(job);

    // A long build heartbeats well past the idle window; it must stay watched.
    for (let beat = 0; beat < 6; beat++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
      store.setJob({
        ...job,
        status: "running",
        heartbeatAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }

    expect(controller.watchedJobIds()).toEqual([job.id]);
    expect(spy.discover).not.toHaveBeenCalled();

    store.setJob({ ...job, status: "succeeded", updatedAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("does not restart the idle window when a reused job is noted again", async () => {
    const frozen = new Date().toISOString();
    const job = createJob({ status: "running", heartbeatAt: frozen, startedAt: frozen });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxIdleWatchMs: 3_000,
      staleHeartbeatMs: 60_000,
    });

    controller.watchJob(job);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    // A duplicate enqueue reuses the same job — the idle window must not restart.
    controller.watchJob(job);
    expect(controller.watchedJobIds()).toEqual([job.id]);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(controller.watchedJobIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("rescans once when a watched job row disappears", async () => {
    const job = createJob({ status: "running" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.watchJob(job);
    store.setJob(null);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.triggers[0].reason).toBe("job-missing");
    expect(controller.watchedJobIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("keeps watching after a transient store read failure", async () => {
    const job = createJob({ status: "running" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const logged: string[] = [];
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      log: (message) => logged.push(message),
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.watchJob(job);
    store.failNextGet(new Error("database is locked"));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).not.toHaveBeenCalled();
    expect(controller.watchedJobIds()).toEqual([job.id]);
    expect(logged.some((message) => message.includes("database is locked"))).toBe(true);

    store.setJob({ ...job, status: "succeeded" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(spy.discover).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("keeps discovery serialized and coalesced across overlapping requests", async () => {
    const store = createFakeStore();
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    spy.hold();
    const first = controller.requestDiscovery();
    await Promise.resolve();
    controller.requestDiscovery();
    controller.requestDiscovery();
    expect(spy.discover).toHaveBeenCalledTimes(1);

    spy.release();
    await first;
    await vi.advanceTimersByTimeAsync(0);

    // The three overlapping requests collapse into the in-flight run plus one rerun.
    expect(spy.discover).toHaveBeenCalledTimes(2);
    expect(spy.maxConcurrent).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("does not reschedule or run discovery after stop", async () => {
    const job = createJob({ status: "running" });
    const store = createFakeStore([job]);
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    controller.watchJob(job);
    controller.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(controller.watchedJobIds()).toEqual([]);

    controller.watchJob(job);
    await controller.requestDiscovery();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);

    expect(spy.discover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("staging preview discovery across processes", () => {
  let dataDir: string;
  let runnerDb: DatabaseSync;
  let serverDb: DatabaseSync;
  let runnerStore: ManagementJobStore;
  let serverStore: ManagementJobStore;

  beforeEach(() => {
    dataDir = makeTestDir("preview-discovery");
    // Two connections to the same database, mirroring the runner and live server.
    runnerDb = openDatabase(dataDir);
    serverDb = openDatabase(dataDir);
    runnerStore = createManagementJobStore(runnerDb, { dataDir });
    serverStore = createManagementJobStore(serverDb, { dataDir });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    runnerDb.close();
    serverDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("observes a completion committed by the runner connection", async () => {
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store: serverStore,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    const queued = serverStore.enqueue("staging_preview", {
      stagingDir: join(dataDir, "worktree"),
      validate: true,
    });
    controller.watchJob(queued);

    runnerStore.claimNext({ runnerPid: 4242 });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(spy.discover).not.toHaveBeenCalled();

    runnerStore.succeed(queued.id, { previewPath: "/staging/worktree/" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(spy.triggers[0].completedJobs[0]).toMatchObject({
      id: queued.id,
      type: "staging_preview",
      status: "succeeded",
    });
    expect(controller.hasScheduledWork()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("resumes an in-flight runner job after a server restart", async () => {
    const queued = serverStore.enqueue("staging_preview", {
      stagingDir: join(dataDir, "worktree"),
      validate: true,
    });
    runnerStore.claimNext({ runnerPid: 4242 });

    // A fresh server process starts with no in-memory state.
    const spy = createDiscoverySpy();
    const controller = createStagingPreviewDiscovery({
      store: serverStore,
      discover: spy.discover,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    controller.resumeActiveJobs();
    expect(controller.watchedJobIds()).toEqual([queued.id]);

    runnerStore.succeed(queued.id, {});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(spy.discover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });
});
