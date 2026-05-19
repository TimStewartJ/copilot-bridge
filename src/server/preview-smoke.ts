import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import express from "express";
import request from "supertest";
import {
  STAGING_TOOLS,
  buildPreviewPrefix,
  cleanupPreviewTarget,
  getActivePreviews,
  getStagingRouter,
  registerExpressApp,
} from "./staging-tools.js";

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

function createSmokeApp() {
  const app = express();
  registerExpressApp(app);

  app.use("/staging/:prefix/api", (req, res, next) => {
    const router = getStagingRouter(req.params.prefix);
    if (router) {
      router(req, res, next);
    } else {
      next();
    }
  });

  app.use("/staging/:prefix", (req, res, next) => {
    const distDir = getActivePreviews().get(req.params.prefix);
    if (!distDir || !existsSync(distDir)) {
      return res.status(404).send("Staging preview not found.");
    }
    express.static(distDir)(req, res, () => {
      res.sendFile(join(distDir, "index.html"));
    });
  });

  return app;
}

function findPreviewTool() {
  const tool = STAGING_TOOLS.find((candidate) => candidate.name === "staging_preview");
  assert(tool, "staging_preview tool not found");
  return tool as {
    handler: (args: { stagingDir: string; validate?: boolean }, invocation?: unknown) => Promise<PreviewResult>;
  };
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

async function main(): Promise<void> {
  const { stagingDir: stagingArg, validate } = parseArgs(process.argv.slice(2));
  const stagingDir = resolveStagingDir(stagingArg);
  assertStagingWorktree(stagingDir);
  const prefix = buildPreviewPrefix(stagingDir);
  const app = createSmokeApp();
  const previewTool = findPreviewTool();

  try {
    const validationNote = validate ? "with validation" : "without validation";
    console.log(`[preview-smoke] building staging preview ${validationNote} for ${stagingDir}`);
    const result = await previewTool.handler({ stagingDir, validate }, {});
    assert.equal(result.success, true, result.error ?? "preview failed");
    assert.equal(result.profile, "clone");
    assert.equal(result.previewPath, `/staging/${prefix}/`);
    assert.equal(result.backendReady, true, result.backendError ?? "preview backend did not start");

    const previewDist = getActivePreviews().get(prefix);
    assert(previewDist && existsSync(previewDist), "preview dist directory was not registered");

    const previewRes = await request(app).get(result.previewPath);
    assert.equal(previewRes.status, 200, "preview root did not return 200");
    assert.match(previewRes.headers["content-type"] ?? "", /text\/html/, "preview root did not serve HTML");
    assert.match(previewRes.text, /<!doctype html>/i, "preview root did not serve the Vite index");

    const tasksRes = await request(app).get(`${result.previewPath}api/tasks`);
    assert.equal(tasksRes.status, 200, "tasks API did not return 200");
    assert(Array.isArray(tasksRes.body.tasks), "tasks response did not include an array");

    const createTaskRes = await request(app)
      .post(`${result.previewPath}api/tasks`)
      .send({ title: "Preview smoke task" });
    assert.equal(createTaskRes.status, 200, "creating a task through staging preview failed");
    assert.equal(createTaskRes.body.task.cwd, undefined, "staging preview unexpectedly defaulted new tasks into a workspace");

    const settingsRes = await request(app).get(`${result.previewPath}api/settings`);
    assert.equal(settingsRes.status, 200, "settings API did not return 200");

    const schedulesRes = await request(app)
      .get(`${result.previewPath}api/schedules?taskId=${encodeURIComponent(startHere.id)}`);
    assert.equal(schedulesRes.status, 200, "schedules API did not return 200");
    assert(Array.isArray(schedulesRes.body), "schedules response was not an array");

    const docsTreeRes = await request(app).get(`${result.previewPath}api/docs/tree`);
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
    await cleanupPreviewTarget(stagingDir);
  }
}

main().catch((error) => {
  console.error("[preview-smoke] failed");
  console.error(error);
  process.exitCode = 1;
});
