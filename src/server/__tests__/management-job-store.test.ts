import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDatabase } from "../db.js";
import {
  ActiveManagementJobError,
  createManagementJobStore,
} from "../management-job-store.js";
import {
  ManagementJobExecutionError,
  type ManagementJobDispatchOptions,
} from "../management-job-dispatch.js";
import {
  runClaimedManagementJob,
} from "../../management-job-runner.js";
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
      expect(() => store.enqueue("staging_preview", { stagingDir: "preview", profile: "clone" })).toThrow(ActiveManagementJobError);
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
});

describe("management job runner", () => {
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
      const ctx = { managementJobStore: store } as any;
      const server = new BridgeToolsMcpServer(ctx);
      registerManagementJobTools(server, ctx);
      const tool = (server as any).tools.get("management_job_status");
      const job = store.enqueue("staging_preview", { stagingDir: join(dataDir, "staging") });

      const queued = await tool.handler({ jobId: job.id }, {} as any);
      expect(queued).toMatchObject({
        success: true,
        terminal: false,
        toolNextAction: "wait",
        pollAfterMs: 10_000,
      });
      expect(queued.content[0].text).toContain('"terminal":false');
      expect(queued.content[0].text).toContain('"nextAction":"wait"');

      store.succeed(job.id, { success: true, previewUrl: "https://bridge.example/staging/x/" });
      const succeeded = await tool.handler({ jobId: job.id }, {} as any);
      expect(succeeded).toMatchObject({
        success: true,
        terminal: true,
        toolNextAction: "respond",
      });
      expect(succeeded.content[0].text).toContain("https://bridge.example/staging/x/");
      expect(succeeded.content[0].text).toContain('"nextAction":"respond"');
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
      expect(previewResult).toMatchObject({ terminal: true, toolNextAction: "respond" });
      expect(previewResult.message).not.toContain("poll");
      expect(previewResult.content[0].text).toContain('"nextAction":"respond"');
      expect(store.get(previewResult.jobId)).toMatchObject({
        type: "staging_preview",
        input: { stagingDir, validate: false, profile: "clone" },
      });

      const deployResult = await deploy.handler({ stagingDir, message: "Ship it" }, {} as any) as any;
      expect(deployResult).toMatchObject({ success: true, status: "queued" });
      expect(deployResult).toMatchObject({ terminal: true, toolNextAction: "respond" });
      expect(deployResult.message).not.toContain("poll");
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
