// Per-session staging worktrees for validated code deployment
// Each session gets an isolated worktree to make changes, run quality checks,
// and deploy only after validation passes.

import { defineTool } from "@github/copilot-sdk";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { triggerRestartPending } from "./session-manager.js";
import { createDirectoryLink, removeDirectoryLink } from "./platform.js";
import { getTunnelUrl } from "./restart-handler.js";
import type { AppContext } from "./app-context.js";
import type express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTION_ROOT = join(__dirname, "..", "..");
const STAGING_PARENT = join(PRODUCTION_ROOT, "..", "bridge-staging");
const STAGING_DIST_PARENT = join(PRODUCTION_ROOT, "dist", "staging");
const STAGING_DATA_PARENT = join(PRODUCTION_ROOT, "data-staging");
const SIGNAL_FILE = join(PRODUCTION_ROOT, "data", "restart.signal");
const PRE_DEPLOY_SHA_FILE = join(PRODUCTION_ROOT, "data", "pre-deploy-sha");
const PRODUCTION_DATA_DIR = join(PRODUCTION_ROOT, "data");

/** Active staging previews: prefix → dist path */
const activePreviews = new Map<string, string>();

/** Active staging backend contexts: prefix → cleanup function */
const activeStagingBackends = new Map<string, { ctx: AppContext; router: express.Router; cleanup: () => Promise<void> }>();

/** Active staged API routers: prefix → router (for delegating middleware in index.ts) */
const activeStagingRouters = new Map<string, express.Router>();

/** Registered Express app — set by registerExpressApp() from index.ts */
let _expressApp: express.Application | null = null;

/** Register the Express app so staging tools can mount/unmount routers */
export function registerExpressApp(app: express.Application): void {
  _expressApp = app;
}

/** Get the staged API router for a prefix (used by delegating middleware in index.ts) */
export function getStagingRouter(prefix: string): express.Router | undefined {
  return activeStagingRouters.get(prefix);
}

/** Returns the map of active staging previews for the Express middleware to use. */
export function getActivePreviews(): ReadonlyMap<string, string> {
  return activePreviews;
}

function removeStagingDist(prefix: string): void {
  const distDir = join(STAGING_DIST_PARENT, prefix);
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true });
  }
  activePreviews.delete(prefix);
}

function removeStagingData(prefix: string): void {
  const dataDir = join(STAGING_DATA_PARENT, prefix);
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Seed a staging data directory from production data, with schedules disabled */
function seedStagingData(prefix: string): string {
  const dataDir = join(STAGING_DATA_PARENT, prefix);
  if (!existsSync(STAGING_DATA_PARENT)) mkdirSync(STAGING_DATA_PARENT, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Copy production SQLite database if it exists
  const dbSrc = join(PRODUCTION_DATA_DIR, "bridge.db");
  if (existsSync(dbSrc)) {
    copyFileSync(dbSrc, join(dataDir, "bridge.db"));
    // Also copy WAL/SHM files if they exist (for consistency)
    const walSrc = join(PRODUCTION_DATA_DIR, "bridge.db-wal");
    const shmSrc = join(PRODUCTION_DATA_DIR, "bridge.db-shm");
    if (existsSync(walSrc)) copyFileSync(walSrc, join(dataDir, "bridge.db-wal"));
    if (existsSync(shmSrc)) copyFileSync(shmSrc, join(dataDir, "bridge.db-shm"));

    // Disable all schedules in the staging copy
    try {
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const stagingDb = new DatabaseSync(join(dataDir, "bridge.db"));
      stagingDb.exec("PRAGMA journal_mode = WAL");
      stagingDb.exec("UPDATE schedules SET enabled = 0");
      stagingDb.close();
    } catch (err) {
      log(`Warning: could not disable schedules in staging DB: ${err}`);
    }
  } else {
    // Fallback: copy JSON files for migration (pre-migration scenario)
    const filesToCopy = [
      "tasks.json", "task-groups.json", "settings.json",
      "sessions-meta.json", "session-titles.json", "read-state.json",
    ];
    for (const file of filesToCopy) {
      const src = join(PRODUCTION_DATA_DIR, file);
      if (existsSync(src)) {
        copyFileSync(src, join(dataDir, file));
      }
    }

    // Copy schedules but disable all of them
    const schedSrc = join(PRODUCTION_DATA_DIR, "schedules.json");
    if (existsSync(schedSrc)) {
      try {
        const schedules = JSON.parse(readFileSync(schedSrc, "utf-8"));
        if (Array.isArray(schedules)) {
          for (const s of schedules) s.enabled = false;
        }
        writeFileSync(join(dataDir, "schedules.json"), JSON.stringify(schedules, null, 2));
      } catch {
        writeFileSync(join(dataDir, "schedules.json"), "[]");
      }
    }
  }

  log(`Seeded staging data at ${dataDir}`);
  return dataDir;
}

/** Dynamically import staged backend modules and create an isolated AppContext */
async function createStagingContext(stagingDir: string, dataDir: string): Promise<AppContext> {
  const base = pathToFileURL(join(stagingDir, "src", "server")).href;
  const ts = (file: string) => `${base}/${file}?v=${Date.now()}`;

  // Dynamic imports from the staging worktree
  const [globalBusMod, eventBusMod, dbMod, migrateMod,
    taskStoreMod, taskGroupStoreMod,
    scheduleStoreMod, settingsStoreMod, sessionMetaStoreMod,
    sessionTitlesMod, readStateStoreMod, todoStoreMod,
    sessionManagerMod, apiRouterMod,
  ] = await Promise.all([
    import(ts("global-bus.ts")),
    import(ts("event-bus.ts")),
    import(ts("db.ts")),
    import(ts("migrate-json-to-sqlite.ts")),
    import(ts("task-store.ts")),
    import(ts("task-group-store.ts")),
    import(ts("schedule-store.ts")),
    import(ts("settings-store.ts")),
    import(ts("session-meta-store.ts")),
    import(ts("session-titles.ts")),
    import(ts("read-state-store.ts")),
    import(ts("todo-store.ts")),
    import(ts("session-manager.ts")),
    import(ts("api-router.ts")),
  ]);

  // Open isolated staging database
  const db = dbMod.openDatabase(dataDir);
  migrateMod.migrateJsonToSqlite(db, dataDir);

  // Create isolated instances
  const globalBus = globalBusMod.createGlobalBus();
  const eventBusRegistry = eventBusMod.createEventBusRegistry();
  const taskStore = taskStoreMod.createTaskStore(db, globalBus);
  const taskGroupStore = taskGroupStoreMod.createTaskGroupStore(db);
  const scheduleStore = scheduleStoreMod.createScheduleStore(db);
  const settingsStore = settingsStoreMod.createSettingsStore(db);
  const sessionMetaStore = sessionMetaStoreMod.createSessionMetaStore(db);
  const sessionTitles = sessionTitlesMod.createSessionTitlesStore(db);
  const readStateStore = readStateStoreMod.createReadStateStore(db);
  const todoStore = todoStoreMod.createTodoStore(db, globalBus);

  const ctx: AppContext = {
    taskStore, taskGroupStore, scheduleStore, settingsStore,
    sessionMetaStore, sessionTitles, readStateStore, todoStore,
    globalBus, eventBusRegistry,
    sessionManager: null as any,
    isStaging: true,
  };

  // Create bridge tools for staging (exclude dangerous tools)
  const allTools = sessionManagerMod.createBridgeTools(ctx);
  const excludeTools = new Set(["self_restart", "staging_init", "staging_preview", "staging_deploy", "staging_cleanup"]);
  const stagingTools = allTools.filter((t: any) => !excludeTools.has(t.name));

  // Create a real SessionManager with its own CopilotClient (stdio mode = independent CLI process)
  const sm = new sessionManagerMod.SessionManager({
    tools: stagingTools,
    globalBus,
    eventBusRegistry,
    sessionTitles,
    taskStore,
    config: { sessionMcpServers: settingsStore.getMcpServers() },
  });
  ctx.sessionManager = sm;

  // Store the apiRouter factory for mounting
  (ctx as any)._createApiRouter = apiRouterMod.createApiRouter;

  return ctx;
}

/** Tear down a staging backend: shutdown SDK, remove data */
async function teardownStagingBackend(prefix: string): Promise<void> {
  const staging = activeStagingBackends.get(prefix);
  if (!staging) return;

  log(`Tearing down staging backend: ${prefix}`);
  activeStagingRouters.delete(prefix);
  try {
    await staging.cleanup();
  } catch (err) {
    log(`Warning: staging cleanup error: ${err}`);
  }
  activeStagingBackends.delete(prefix);
  removeStagingData(prefix);
  log(`Staging backend torn down: ${prefix}`);
}

function log(msg: string) {
  console.log(`[staging] ${msg}`);
}

function run(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

/** Remove a staging worktree and its branch. Handles node_modules junction cleanup. */
function removeWorktree(stagingDir: string, branch: string): void {
  // Remove node_modules junction/symlink first — git worktree remove can't handle it
  const junctionPath = join(stagingDir, "node_modules");
  if (existsSync(junctionPath)) {
    removeDirectoryLink(junctionPath, PRODUCTION_ROOT);
  }
  run(`git worktree remove "${stagingDir}" --force`, PRODUCTION_ROOT);
  run(`git branch -D "${branch}"`, PRODUCTION_ROOT);
  run("git worktree prune", PRODUCTION_ROOT);
}

/**
 * Prune orphaned staging worktrees on server startup.
 * Called from server initialization — removes worktrees whose branches
 * no longer exist or whose directories are stale.
 */
export function pruneOrphanedWorktrees(): void {
  // Collect active staging prefixes (worktrees with valid branches)
  const activeWorktrees = new Set<string>();

  if (existsSync(STAGING_PARENT)) {
    try {
      const entries = readdirSync(STAGING_PARENT, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stagingDir = join(STAGING_PARENT, entry.name);
        const branch = `staging/${entry.name}`;

        const branchCheck = run(`git rev-parse --verify "${branch}"`, PRODUCTION_ROOT);
        if (!branchCheck.ok) {
          log(`Pruning orphaned staging directory (no branch): ${stagingDir}`);
          removeWorktree(stagingDir, branch);
          continue;
        }

        activeWorktrees.add(entry.name);
        log(`Found active staging worktree: ${stagingDir} (branch: ${branch})`);
      }

      run("git worktree prune", PRODUCTION_ROOT);
    } catch (err) {
      log(`Warning: orphan pruning failed: ${err}`);
    }
  }

  // Clean up orphaned staging dist directories, but keep ones with active worktrees
  if (existsSync(STAGING_DIST_PARENT)) {
    try {
      const distEntries = readdirSync(STAGING_DIST_PARENT, { withFileTypes: true });
      for (const entry of distEntries) {
        if (!entry.isDirectory()) continue;
        if (activeWorktrees.has(entry.name)) {
          // Re-register the preview so Express can serve it after restart
          const distDir = join(STAGING_DIST_PARENT, entry.name);
          activePreviews.set(entry.name, distDir);
          log(`Restored staging preview: ${entry.name}`);
        } else {
          log(`Pruning orphaned staging dist: ${entry.name}`);
          rmSync(join(STAGING_DIST_PARENT, entry.name), { recursive: true, force: true });
        }
      }
    } catch (err) {
      log(`Warning: staging dist pruning failed: ${err}`);
    }
  }
}

export const STAGING_TOOLS = [
  defineTool("staging_init", {
    description:
      "Create a fresh staging worktree for making code changes to the bridge. " +
      "Returns the staging directory path where you should make all edits. " +
      "Run quality checks (npx tsc --noEmit, npx vite build) in that directory before calling staging_deploy.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const prefix = randomBytes(4).toString("hex");
      const stagingDir = join(STAGING_PARENT, prefix);
      const branch = `staging/${prefix}`;

      log(`Creating staging worktree: ${stagingDir} (branch: ${branch})`);

      // Pull latest from origin so the worktree starts from the newest remote state
      const currentBranch = run("git rev-parse --abbrev-ref HEAD", PRODUCTION_ROOT);
      const branchName = currentBranch.ok ? currentBranch.output.trim() : "main";
      const pullResult = run(`git pull --rebase origin ${branchName}`, PRODUCTION_ROOT);
      if (pullResult.ok) {
        log("Pulled latest from origin");
      } else {
        log(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
      }

      if (!existsSync(STAGING_PARENT)) {
        mkdirSync(STAGING_PARENT, { recursive: true });
      }

      // Create branch from current HEAD
      const branchResult = run(`git branch "${branch}"`, PRODUCTION_ROOT);
      if (!branchResult.ok) {
        return { success: false, error: `Failed to create branch ${branch}: ${branchResult.output}` };
      }

      // Create worktree
      const wtResult = run(`git worktree add "${stagingDir}" "${branch}"`, PRODUCTION_ROOT);
      if (!wtResult.ok) {
        run(`git branch -D "${branch}"`, PRODUCTION_ROOT);
        return { success: false, error: `Failed to create worktree: ${wtResult.output}` };
      }

      // Share node_modules via junction (Windows) or symlink (Linux)
      const prodModules = join(PRODUCTION_ROOT, "node_modules");
      const stagingModules = join(stagingDir, "node_modules");
      if (existsSync(prodModules) && !existsSync(stagingModules)) {
        const jResult = createDirectoryLink(stagingModules, prodModules, PRODUCTION_ROOT);
        if (!jResult.ok) {
          log(`Warning: node_modules link failed: ${jResult.output}`);
        }
      }

      log(`Staging worktree ready: ${stagingDir}`);
      return {
        success: true,
        stagingDir,
        branch,
        message:
          `Staging worktree created at ${stagingDir}. ` +
          `Make your changes there, run quality checks, then call staging_deploy when ready.`,
      };
    },
  }),

  defineTool("staging_preview", {
    description:
      "Build and serve a preview of the staged frontend changes. " +
      "Runs vite build with a staging base path and makes it available at /staging/<prefix>/ on the main server. " +
      "Also spins up a staged backend with isolated data and a real Copilot SDK instance. " +
      "Share the preview URL with the user and wait for confirmation before calling staging_deploy.",
    parameters: {
      type: "object",
      properties: {
        stagingDir: { type: "string", description: "Path to the staging worktree (returned by staging_init)" },
      },
      required: ["stagingDir"],
    },
    handler: async (args: any) => {
      const { stagingDir } = args;

      if (!existsSync(stagingDir)) {
        return { success: false, error: `Staging directory not found: ${stagingDir}. Call staging_init first.` };
      }

      const prefix = basename(stagingDir);
      const basePath = `/staging/${prefix}/`;
      const outDir = join(STAGING_DIST_PARENT, prefix);

      log(`Building staging preview: ${stagingDir} → ${outDir} (base: ${basePath})`);

      if (!existsSync(STAGING_DIST_PARENT)) {
        mkdirSync(STAGING_DIST_PARENT, { recursive: true });
      }

      // Build the client with the staging base path
      const buildResult = run(
        `npx vite build --base "${basePath}" --outDir "${outDir}" --emptyOutDir`,
        stagingDir,
      );
      if (!buildResult.ok) {
        return { success: false, error: `Vite build failed:\n${buildResult.output.slice(-500)}` };
      }

      // Register the preview for Express to serve
      activePreviews.set(prefix, outDir);

      // ── Staged backend ──────────────────────────────────────────
      let backendReady = false;
      let backendError: string | undefined;

      if (_expressApp) {
        try {
          // Tear down any existing staging backend for this prefix
          await teardownStagingBackend(prefix);

          // Seed isolated data directory
          const dataDir = seedStagingData(prefix);

          // Create staging AppContext from worktree code
          log(`Creating staging backend context from ${stagingDir}...`);
          const ctx = await createStagingContext(stagingDir, dataDir);

          // Initialize the staging SessionManager (spawns its own CLI process)
          log("Initializing staging Copilot SDK...");
          await ctx.sessionManager.initialize();

          // Mount staged API router
          const createRouter = (ctx as any)._createApiRouter;
          const stagedRouter = createRouter(ctx);
          activeStagingRouters.set(prefix, stagedRouter);
          log(`Staged API registered for prefix ${prefix}`);

          // Store for cleanup
          activeStagingBackends.set(prefix, {
            ctx,
            router: stagedRouter,
            cleanup: async () => {
              try {
                await ctx.sessionManager.gracefulShutdown();
              } catch (err) {
                log(`Warning: staging SDK shutdown error: ${err}`);
              }
            },
          });

          backendReady = true;
          log("Staging backend ready");
        } catch (err) {
          backendError = err instanceof Error ? err.message : String(err);
          log(`Staging backend failed (frontend-only preview): ${backendError}`);
        }
      } else {
        log("Express app not registered — frontend-only preview");
      }

      const tunnelUrl = getTunnelUrl();
      const fullUrl = tunnelUrl ? `${tunnelUrl.replace(/\/+$/, "")}${basePath}` : null;

      const backendNote = backendReady
        ? " Backend API is live at the same path (/api routes)."
        : backendError
          ? ` Backend failed to start: ${backendError}. Frontend-only preview.`
          : " Frontend-only preview (no Express app registered).";

      log(`Staging preview ready at ${fullUrl || basePath}`);
      return {
        success: true,
        previewPath: basePath,
        previewUrl: fullUrl,
        backendReady,
        backendError,
        message: (fullUrl
          ? `Staging preview is live at ${fullUrl} — share this link with the user and wait for confirmation before deploying.`
          : `Staging preview is live at ${basePath} (no tunnel URL available — share the relative path with the user).`) + backendNote,
      };
    },
  }),

  defineTool("staging_deploy", {
    description:
      "Deploy validated changes from a staging worktree to production. " +
      "Commits changes in staging, merges to main, signals the launcher to restart, and auto-cleans the worktree. " +
      "IMPORTANT: Do not make further tool calls after this — the server will restart.",
    parameters: {
      type: "object",
      properties: {
        stagingDir: { type: "string", description: "Path to the staging worktree (returned by staging_init)" },
        message: { type: "string", description: "Commit message describing the changes" },
      },
      required: ["stagingDir", "message"],
    },
    handler: async (args: any) => {
      const { stagingDir, message } = args;

      if (!existsSync(stagingDir)) {
        return { success: false, error: `Staging directory not found: ${stagingDir}. Call staging_init first.` };
      }

      if (existsSync(SIGNAL_FILE)) {
        return { success: false, error: "A restart is already pending. Wait for it to complete before deploying." };
      }

      const prefix = basename(stagingDir);
      const branch = `staging/${prefix}`;

      log(`Deploying from ${stagingDir} (branch: ${branch})`);

      // Stage and check for changes
      run("git add -A", stagingDir);
      const status = run("git --no-pager status --porcelain", stagingDir);
      if (!status.ok || !status.output.trim()) {
        return { success: false, error: "Nothing to deploy — no changes detected in staging." };
      }

      // Commit using a temp file to avoid shell injection from message content
      const msgFile = join(stagingDir, ".commit-msg");
      try {
        writeFileSync(
          msgFile,
          `${message}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n`,
        );
        const commitResult = run(`git commit -F "${msgFile}"`, stagingDir);
        if (!commitResult.ok) {
          return { success: false, error: `Commit failed: ${commitResult.output}` };
        }
      } finally {
        try { unlinkSync(msgFile); } catch {}
      }

      // Store pre-deploy SHA so the launcher can roll back to exactly this point
      const headResult = run("git rev-parse HEAD", PRODUCTION_ROOT);
      const preDeploySha = headResult.ok ? headResult.output.trim() : "";
      if (preDeploySha) {
        const dataDir = join(PRODUCTION_ROOT, "data");
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        writeFileSync(PRE_DEPLOY_SHA_FILE, preDeploySha);
        log(`Pre-deploy SHA saved: ${preDeploySha}`);
      }

      // Merge into production
      const mergeResult = run(`git merge "${branch}" --no-edit`, PRODUCTION_ROOT);
      if (!mergeResult.ok) {
        run("git merge --abort", PRODUCTION_ROOT);
        try { unlinkSync(PRE_DEPLOY_SHA_FILE); } catch {}
        return {
          success: false,
          error:
            `Merge conflict — the merge has been aborted. ` +
            `Call staging_cleanup then staging_init to start fresh from current main.\n\n` +
            mergeResult.output.slice(-500),
        };
      }

      const newHead = run("git rev-parse --short HEAD", PRODUCTION_ROOT);
      const commitSha = newHead.ok ? newHead.output.trim() : "unknown";
      log(`Merged to production: ${commitSha}`);

      // Install deps if package.json changed (staging had its own node_modules)
      const pkgChanged = run(`git diff "${preDeploySha}" HEAD --name-only -- package.json`, PRODUCTION_ROOT);
      if (pkgChanged.ok && pkgChanged.output.trim().includes("package.json")) {
        log("package.json changed — running npm install in production...");
        const npmResult = run("npm install --no-audit --no-fund", PRODUCTION_ROOT);
        if (!npmResult.ok) {
          log(`npm install failed (non-fatal): ${npmResult.output.slice(-300)}`);
        } else {
          log("npm install succeeded");
        }
      }

      // Push to origin so other deployments can pick up the change
      const prodBranch = run("git rev-parse --abbrev-ref HEAD", PRODUCTION_ROOT);
      const pushBranch = prodBranch.ok ? prodBranch.output.trim() : "main";
      let pushResult = run(`git push origin ${pushBranch}`, PRODUCTION_ROOT);
      if (!pushResult.ok) {
        // Push may fail if remote has new commits — pull --rebase and retry once
        log("Push failed, attempting pull --rebase before retry...");
        const rebase = run(`git pull --rebase origin ${pushBranch}`, PRODUCTION_ROOT);
        if (rebase.ok) {
          pushResult = run(`git push origin ${pushBranch}`, PRODUCTION_ROOT);
        }
      }
      if (pushResult.ok) {
        log("Pushed to origin");
      } else {
        log(`Git push failed (non-fatal): ${pushResult.output.slice(-200)}`);
      }

      // Signal launcher to restart
      const dataDir = join(PRODUCTION_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      triggerRestartPending();
      log("Restart signal sent");

      // Cleanup staging worktree and branch
      removeWorktree(stagingDir, branch);
      removeStagingDist(prefix);
      await teardownStagingBackend(prefix);
      log("Staging worktree cleaned up");

      return {
        success: true,
        commitSha,
        message: `Deployed ${commitSha} to production. Restart signal sent — do NOT make any more tool calls.`,
      };
    },
  }),

  defineTool("staging_cleanup", {
    description: "Abandon a staging worktree and discard all changes. Use when you don't want to deploy, or to start fresh after a failed merge.",
    parameters: {
      type: "object",
      properties: {
        stagingDir: { type: "string", description: "Path to the staging worktree to remove (returned by staging_init)" },
      },
      required: ["stagingDir"],
    },
    handler: async (args: any) => {
      const { stagingDir } = args;

      if (!existsSync(stagingDir)) {
        return { success: true, message: "Staging directory does not exist — nothing to clean up." };
      }

      const prefix = basename(stagingDir);
      const branch = `staging/${prefix}`;

      log(`Cleaning up staging worktree: ${stagingDir}`);

      removeWorktree(stagingDir, branch);
      removeStagingDist(prefix);
      await teardownStagingBackend(prefix);

      log("Staging worktree cleaned up");
      return { success: true, message: `Staging worktree removed: ${stagingDir}` };
    },
  }),
];
