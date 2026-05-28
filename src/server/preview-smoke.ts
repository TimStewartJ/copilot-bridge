import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "./db.js";
import { openDatabase } from "./db.js";
import { createDocsStore } from "./docs-store.js";
import { createGlobalBus } from "./global-bus.js";
import { createManagementJobStore } from "./management-job-store.js";
import { createSettingsStore } from "./settings-store.js";
import { createTaskStore } from "./task-store.js";
import express from "express";
import request from "supertest";

interface PreviewResult {
  success: boolean;
  profile: "clone";
  previewPath: string;
  previewUrl: string | null;
  localUrl: string;
  backendReady: boolean;
  backendError?: string;
  error?: string;
}

interface QueuedPreviewResult {
  success: true;
  jobId: string;
  status: "queued" | "running";
}

interface PreviewSmokeSource {
  rootDir: string;
  dataDir: string;
  docsDir: string;
  docsSnapshotsDir: string;
  copilotHome: string;
  taskId: string;
}

interface StagingToolsModule {
  STAGING_TOOLS: Array<{
    name: string;
    handler?: (args: { stagingDir: string; validate?: boolean }, invocation?: unknown) => Promise<PreviewResult | QueuedPreviewResult>;
  }>;
  buildPreviewPrefix(stagingDir: string): string;
  cleanupPreviewTarget(
    stagingDir: string,
    profile?: "clone",
    options?: { removeData?: boolean },
  ): Promise<void>;
  getActivePreviews(): ReadonlyMap<string, string>;
  getStagingRouter(prefix: string): express.RequestHandler | undefined;
  registerExpressApp(app: express.Application): void;
  registerExistingPreviewsFromDisk(options?: { stagingParent?: string }): number;
  createStagingToolDefinitions(ctx: unknown): Array<{
    name: string;
    handler?: (args: { stagingDir: string; validate?: boolean }, invocation?: unknown) => Promise<PreviewResult | QueuedPreviewResult>;
  }>;
}

const PREVIEW_SMOKE_ENV_KEYS = [
  "BRIDGE_DATA_DIR",
  "BRIDGE_DOCS_DIR",
  "BRIDGE_DOCS_SNAPSHOTS_DIR",
  "COPILOT_HOME",
] as const;
const PREVIEW_SMOKE_CLEANUP_MAX_RETRIES = 10;
const PREVIEW_SMOKE_CLEANUP_RETRY_DELAY_MS = 50;
const REQUIRED_FIXTURE_TABLES = [
  "settings",
  "tasks",
  "schedules",
  "push_subscriptions",
] as const;

function createSmokeApp(stagingTools: StagingToolsModule) {
  const app = express();
  stagingTools.registerExpressApp(app);

  app.use("/staging/:prefix/api", (req, res, next) => {
    const router = stagingTools.getStagingRouter(req.params.prefix);
    if (router) {
      router(req, res, next);
    } else {
      next();
    }
  });

  app.use("/staging/:prefix", (req, res, next) => {
    const distDir = stagingTools.getActivePreviews().get(req.params.prefix);
    if (!distDir || !existsSync(distDir)) {
      return res.status(404).send("Staging preview not found.");
    }
    express.static(distDir)(req, res, () => {
      res.sendFile(join(distDir, "index.html"));
    });
  });

  return app;
}

async function requestWithBackendRetry(app: express.Application, path: string): Promise<request.Response> {
  let last = await request(app).get(path);
  for (let attempt = 0; attempt < 10 && (last.status === 503 || last.status === 502); attempt++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    last = await request(app).get(path);
  }
  return last;
}

function findPreviewTool(stagingTools: StagingToolsModule, ctx: unknown) {
  const tool = stagingTools.createStagingToolDefinitions(ctx).find((candidate) => candidate.name === "staging_preview");
  assert(tool, "staging_preview tool not found");
  assert(typeof tool.handler === "function", "staging_preview handler not found");
  return tool as { handler: NonNullable<typeof tool.handler> };
}

function isQueuedPreviewResult(value: PreviewResult | QueuedPreviewResult): value is QueuedPreviewResult {
  return typeof (value as { jobId?: unknown }).jobId === "string";
}

async function resolveQueuedPreviewResult(
  source: PreviewSmokeSource,
  jobId: string,
): Promise<PreviewResult> {
  const [{ createManagementJobStore }, { runClaimedManagementJob }] = await Promise.all([
    import("./management-job-store.js"),
    import("../management-job-runner.js"),
  ]);
  const db = openDatabase(source.dataDir);
  try {
    const store = createManagementJobStore(db, { dataDir: source.dataDir });
    const claimed = store.claimNext({ runnerPid: process.pid, staleAfterMs: 1 });
    assert(claimed?.id === jobId, `expected to claim queued preview job ${jobId}`);
    await runClaimedManagementJob(store, claimed, {
      heartbeatIntervalMs: 100,
      log: (message) => console.log(`[preview-smoke job] ${message}`),
    });
    const completed = store.get(jobId);
    assert(completed, `queued preview job disappeared: ${jobId}`);
    assert.equal(completed.status, "succeeded", completed.error ?? "preview job failed");
    return completed.result as PreviewResult;
  } finally {
    db.close();
  }
}

function resolveStagingDir(input?: string): string {
  const candidate = resolve(input ?? process.cwd());
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate,
      encoding: "utf-8",
    }).trim();
  } catch {
    throw new Error(`preview smoke must run inside a git worktree or receive one explicitly: ${candidate}`);
  }
}

function assertStagingWorktree(stagingDir: string): void {
  assert.equal(
    basename(dirname(stagingDir)),
    "bridge-staging",
    `preview smoke must target a staging worktree under a bridge-staging parent: ${stagingDir}`,
  );

  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: stagingDir,
    encoding: "utf-8",
  }).trim();
  assert.match(branch, /^staging\//, `preview smoke must target a staging/* worktree, got branch ${branch}`);
}

function parseArgs(argv: string[]): { stagingDir?: string; validate: boolean } {
  let stagingDir: string | undefined;
  let validate = false;

  for (const arg of argv) {
    if (arg === "--validate" || arg === "--full") {
      validate = true;
      continue;
    }
    if (arg === "--no-validate") {
      validate = false;
      continue;
    }
    if (!stagingDir) {
      stagingDir = arg;
      continue;
    }
    throw new Error(`unexpected preview smoke argument: ${arg}`);
  }

  return { stagingDir, validate };
}

function isPathAtOrUnder(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function assertFixtureSchema(db: DatabaseSync): void {
  for (const table of REQUIRED_FIXTURE_TABLES) {
    const row = db.prepare(
      "SELECT 1 as found FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { found?: number } | undefined;
    assert.equal(row?.found, 1, `preview smoke fixture is missing required table: ${table}`);
  }
}

function createPreviewSmokeSource(stagingDir: string): PreviewSmokeSource {
  const fixtureParent = join(stagingDir, ".preview-smoke-fixture");
  mkdirSync(fixtureParent, { recursive: true });
  const rootDir = mkdtempSync(join(fixtureParent, "run-"));
  const dataDir = join(rootDir, "data");
  const docsDir = join(dataDir, "docs");
  const docsSnapshotsDir = join(dataDir, "backups", "docs", "snapshots");
  const copilotHome = join(dataDir, ".copilot");
  mkdirSync(docsSnapshotsDir, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });

  const db = openDatabase(dataDir);
  let taskId: string;
  try {
    assertFixtureSchema(db);
    createSettingsStore(db).updateSettings({ theme: "system" });
    const fixtureTask = createTaskStore(db, createGlobalBus()).createTask("Preview Smoke Fixture");
    taskId = fixtureTask.id;
  } finally {
    db.close();
  }

  const docsStore = createDocsStore(docsDir);
  docsStore.writePage("smoke/index", "# Preview Smoke Fixture\n\nSynthetic docs used by preview smoke validation.");

  return { rootDir, dataDir, docsDir, docsSnapshotsDir, copilotHome, taskId };
}

function installPreviewSmokeSourceEnv(source: PreviewSmokeSource): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of PREVIEW_SMOKE_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }
  process.env.BRIDGE_DATA_DIR = source.dataDir;
  process.env.BRIDGE_DOCS_DIR = source.docsDir;
  process.env.BRIDGE_DOCS_SNAPSHOTS_DIR = source.docsSnapshotsDir;
  process.env.COPILOT_HOME = source.copilotHome;

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function cleanupPreviewSmokeSource(source: PreviewSmokeSource): void {
  rmSync(source.rootDir, {
    recursive: true,
    force: true,
    maxRetries: PREVIEW_SMOKE_CLEANUP_MAX_RETRIES,
    retryDelay: PREVIEW_SMOKE_CLEANUP_RETRY_DELAY_MS,
  });
}

async function main(): Promise<void> {
  const { stagingDir: stagingArg, validate } = parseArgs(process.argv.slice(2));
  const stagingDir = resolveStagingDir(stagingArg);
  assertStagingWorktree(stagingDir);
  const source = createPreviewSmokeSource(stagingDir);
  const restoreEnv = installPreviewSmokeSourceEnv(source);
  let stagingTools: StagingToolsModule | undefined;

  try {
    stagingTools = await import("./staging-tools.js") as StagingToolsModule;
    const previewShared = await import("./staging-preview-shared.js");
    assert.equal(
      resolve(previewShared.PRODUCTION_DATA_DIR),
      resolve(source.dataDir),
      "preview smoke must use its synthetic source data directory",
    );
    assert(isPathAtOrUnder(source.rootDir, previewShared.STAGING_PREVIEW_PARENT), "preview output must stay under the synthetic fixture root");

    const prefix = stagingTools.buildPreviewPrefix(stagingDir);
    const app = createSmokeApp(stagingTools);
    const validationNote = validate ? "with validation" : "without validation";
    console.log(`[preview-smoke] building staging preview ${validationNote} for ${stagingDir}`);
    const initialResult = await (async () => {
      const db = openDatabase(source.dataDir);
      try {
        const previewTool = findPreviewTool(stagingTools, {
          managementJobStore: createManagementJobStore(db, { dataDir: source.dataDir }),
        });
        return await previewTool.handler({ stagingDir, validate }, {});
      } finally {
        db.close();
      }
    })();
    const result = isQueuedPreviewResult(initialResult)
      ? await resolveQueuedPreviewResult(source, initialResult.jobId)
      : initialResult;
    stagingTools.registerExistingPreviewsFromDisk({ stagingParent: dirname(stagingDir) });
    assert.equal(result.success, true, result.error ?? "preview failed");
    assert.equal(result.profile, "clone");
    assert.equal(result.previewPath, `/staging/${prefix}/`);
    if (result.backendError) {
      throw new Error(result.backendError);
    }

    const previewDist = stagingTools.getActivePreviews().get(prefix);
    assert(previewDist && existsSync(previewDist), "preview dist directory was not registered");

    const previewRes = await request(app).get(result.previewPath);
    assert.equal(previewRes.status, 200, "preview root did not return 200");
    assert.match(previewRes.headers["content-type"] ?? "", /text\/html/, "preview root did not serve HTML");
    assert.match(previewRes.text, /<!doctype html>/i, "preview root did not serve the Vite index");

    const tasksRes = await requestWithBackendRetry(app, `${result.previewPath}api/tasks`);
    assert.equal(tasksRes.status, 200, "tasks API did not return 200");
    assert(Array.isArray(tasksRes.body.tasks), "tasks response did not include an array");

    const createTaskRes = await request(app)
      .post(`${result.previewPath}api/tasks`)
      .send({ title: "Preview smoke task" });
    assert.equal(createTaskRes.status, 200, "creating a task through staging preview failed");
    assert.equal(createTaskRes.body.task.cwd, undefined, "staging preview unexpectedly defaulted new tasks into a workspace");

    const settingsRes = await requestWithBackendRetry(app, `${result.previewPath}api/settings`);
    assert.equal(settingsRes.status, 200, "settings API did not return 200");

    const schedulesRes = await requestWithBackendRetry(app, `${result.previewPath}api/schedules?taskId=${encodeURIComponent(source.taskId)}`);
    assert.equal(schedulesRes.status, 200, "schedules API did not return 200");
    assert(Array.isArray(schedulesRes.body), "schedules response was not an array");

    const docsTreeRes = await requestWithBackendRetry(app, `${result.previewPath}api/docs/tree`);
    assert.equal(docsTreeRes.status, 200, "docs tree API did not return 200");
    assert(Array.isArray(docsTreeRes.body.tree), "docs tree response did not include an array");

    console.log(JSON.stringify({
      ok: true,
      stagingDir,
      prefix,
      previewPath: result.previewPath,
      localUrl: result.localUrl,
      previewUrl: result.previewUrl,
      taskCount: tasksRes.body.tasks.length,
      createdTaskId: createTaskRes.body.task.id,
      createdTaskCwd: createTaskRes.body.task.cwd,
      settings: {
        theme: settingsRes.body.theme,
        favicon: settingsRes.body.favicon,
        reasoningEffort: settingsRes.body.reasoningEffort,
      },
      scheduleNames: schedulesRes.body.map((schedule: any) => schedule.name),
      docsNodeCount: docsTreeRes.body.tree.length,
    }, null, 2));
  } finally {
    if (stagingTools) {
      await stagingTools.cleanupPreviewTarget(stagingDir, "clone", { removeData: false });
    }
    restoreEnv();
    cleanupPreviewSmokeSource(source);
  }
}

main().catch((error) => {
  console.error("[preview-smoke] failed");
  console.error(error);
  process.exitCode = 1;
});
