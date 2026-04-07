// Per-session staging worktrees for validated code deployment
// Each session gets an isolated worktree to make changes, run quality checks,
// and deploy only after validation passes.

import { defineTool } from "@github/copilot-sdk";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, rmSync, copyFileSync, cpSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { triggerRestartPending } from "./session-manager.js";
import { createDirectoryLink, removeDirectoryLink } from "./platform.js";
import { getTunnelUrl } from "./tunnel.js";
import type { AppContext } from "./app-context.js";
import type express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTION_ROOT = join(__dirname, "..", "..");
const STAGING_PARENT = join(PRODUCTION_ROOT, "..", "bridge-staging");
const STAGING_DIST_PARENT = join(PRODUCTION_ROOT, "dist", "staging");
const SIGNAL_FILE= join(PRODUCTION_ROOT, "data", "restart.signal");
const PRE_DEPLOY_SHA_FILE = join(PRODUCTION_ROOT, "data", "pre-deploy-sha");
const PRODUCTION_DATA_DIR = join(PRODUCTION_ROOT, "data");

/**
 * Compare package.json between staging and production.
 * If different, replace the node_modules symlink with a real npm install
 * so new/removed dependencies are available for builds.
 */
function ensureStagingDeps(stagingDir: string): void {
  const stagingPkg = join(stagingDir, "package.json");
  const prodPkg = join(PRODUCTION_ROOT, "package.json");
  if (!existsSync(stagingPkg) || !existsSync(prodPkg)) return;

  const stagingContent = readFileSync(stagingPkg, "utf-8");
  const prodContent = readFileSync(prodPkg, "utf-8");
  if (stagingContent === prodContent) return;

  log("Staging package.json differs from production — installing dependencies in staging...");

  // Remove the symlink/junction so npm install can create a real node_modules
  const stagingModules = join(stagingDir, "node_modules");
  if (existsSync(stagingModules)) {
    removeDirectoryLink(stagingModules, PRODUCTION_ROOT);
  }

  const result = run("npm install --no-audit --no-fund", stagingDir);
  if (!result.ok) {
    log(`Warning: staging npm install failed: ${result.output.slice(-300)}`);
    // Fall back to re-linking production node_modules so builds at least attempt to work
    const prodModules = join(PRODUCTION_ROOT, "node_modules");
    if (existsSync(prodModules) && !existsSync(stagingModules)) {
      createDirectoryLink(stagingModules, prodModules, PRODUCTION_ROOT);
    }
  } else {
    log("Staging npm install succeeded");
  }
}

/** Active staging previews: prefix → dist path */
const activePreviews = new Map<string, string>();

/** Active staging backend contexts: prefix → cleanup function */
const activeStagingBackends = new Map<string, { ctx: AppContext; router: express.Router; db?: DatabaseSync; cleanup: () => Promise<void> }>();

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

function removeStagingData(stagingDir: string): void {
  const dataDir = join(stagingDir, "data");
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Seed a staging data directory from production data, with schedules disabled.
 *  Uses the worktree's own data/ directory (already gitignored). */
function seedStagingData(stagingDir: string): string {
  const dataDir = join(stagingDir, "data");
  mkdirSync(dataDir, { recursive: true });

  // Copy production SQLite database if it exists
  const dbSrc = join(PRODUCTION_DATA_DIR, "bridge.db");
  if (existsSync(dbSrc)) {
    // Copy production DB via VACUUM INTO for a clean, WAL-inclusive snapshot
    try {
      const prodDb = new DatabaseSync(dbSrc, { readOnly: true });
      const destPath = join(dataDir, "bridge.db").replaceAll("\\", "/");
      prodDb.exec(`VACUUM INTO '${destPath}'`);
      prodDb.close();
    } catch (err) {
      log(`Warning: SQLite VACUUM INTO failed, falling back to file copy: ${err}`);
      copyFileSync(dbSrc, join(dataDir, "bridge.db"));
    }

    // Disable all schedules in the staging copy
    try {
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

  // Copy docs directory (source of truth is filesystem, not SQLite)
  const docsSrc = join(PRODUCTION_DATA_DIR, "docs");
  if (existsSync(docsSrc)) {
    cpSync(docsSrc, join(dataDir, "docs"), { recursive: true });
  }

  log(`Seeded staging data at ${dataDir}`);
  return dataDir;
}

/** Dynamically import staged backend modules and create an isolated AppContext */
async function createStagingContext(stagingDir: string, dataDir: string): Promise<{ ctx: AppContext; db: DatabaseSync }> {
  const base = pathToFileURL(join(stagingDir, "src", "server")).href;
  const ts = (file: string) => `${base}/${file}?v=${Date.now()}`;

  // Dynamic imports from the staging worktree
  const [globalBusMod, eventBusMod, dbMod, migrateMod,
    taskStoreMod, taskGroupStoreMod,
    scheduleStoreMod, settingsStoreMod, sessionMetaStoreMod,
    sessionTitlesMod, readStateStoreMod, todoStoreMod,
    docsStoreMod, docsIndexMod, sessionManagerMod, apiRouterMod,
    tagStoreMod,
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
    import(ts("docs-store.ts")).catch(() => null),
    import(ts("docs-index.ts")).catch(() => null),
    import(ts("session-manager.ts")),
    import(ts("api-router.ts")),
    import(ts("tag-store.ts")).catch(() => null),
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
  const tagStore = tagStoreMod?.createTagStore(db);
  const docsStore = docsStoreMod?.createDocsStore(join(dataDir, "docs"));
  const docsIndex = docsStore && docsIndexMod ? docsIndexMod.createDocsIndex(db, docsStore) : null;
  if (docsIndex) docsIndex.reindex();

  // COPILOT_HOME isolates session storage so listSessions() only returns staging sessions
  const copilotHome = join(dataDir, ".copilot");
  mkdirSync(copilotHome, { recursive: true });

  const ctx: AppContext = {
    taskStore, taskGroupStore, scheduleStore, settingsStore,
    sessionMetaStore, sessionTitles, readStateStore, todoStore,
    ...(docsStore && { docsStore }),
    ...(docsIndex && { docsIndex }),
    ...(tagStore && { tagStore }),
    globalBus, eventBusRegistry,
    sessionManager: null as any,
    copilotHome,
    isStaging: true,
  };

  // Create bridge tools for staging (exclude dangerous tools)
  const allTools = sessionManagerMod.createBridgeTools(ctx);
  const excludeTools = new Set(["self_restart", "staging_init", "staging_preview", "staging_deploy", "staging_cleanup"]);
  const stagingTools = allTools.filter((t: any) => !excludeTools.has(t.name));

  // Create a real SessionManager with its own CopilotClient (stdio mode = independent CLI process)
  // COPILOT_HOME isolates session storage so listSessions() only returns staging sessions
  const sm = new sessionManagerMod.SessionManager({
    tools: stagingTools,
    globalBus,
    eventBusRegistry,
    sessionTitles,
    taskStore,
    todoStore,
    ...(tagStore && { tagStore }),
    config: { sessionMcpServers: settingsStore.getMcpServers(), model: "claude-haiku-4.5" },
    clientEnv: { ...process.env, COPILOT_HOME: copilotHome },
    copilotHome,
  });
  ctx.sessionManager = sm;

  // Store the apiRouter factory for mounting
  (ctx as any)._createApiRouter = apiRouterMod.createApiRouter;

  return { ctx, db };
}

/** Tear down a staging backend: shutdown SDK, close DB, remove data */
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
  // Close the SQLite handle before deleting data files (prevents EPERM on Windows)
  if (staging.db) {
    try { staging.db.close(); } catch (err) { log(`Warning: staging DB close error: ${err}`); }
  }
  activeStagingBackends.delete(prefix);
  const stagingDir = join(STAGING_PARENT, prefix);
  removeStagingData(stagingDir);
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

/** Ensure node_modules is properly ignored (covers both directories and symlinks). */
function ensureNodeModulesIgnored(stagingDir: string): void {
  const gitignorePath = join(stagingDir, ".gitignore");
  if (!existsSync(gitignorePath)) return;
  const content = readFileSync(gitignorePath, "utf-8");
  if (content.split("\n").some(line => line.trim() === "node_modules")) return;
  // Replace dir-only pattern with one that covers symlinks too
  const fixed = content.replace(/^node_modules\/$/m, "node_modules");
  if (fixed !== content) {
    writeFileSync(gitignorePath, fixed);
  } else {
    writeFileSync(gitignorePath, content.trimEnd() + "\nnode_modules\n");
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
 * Prune orphaned staging worktrees on server startup and restore surviving previews.
 * Called from server initialization — removes worktrees whose branches
 * no longer exist, and fully restores (frontend + backend) previews that survived a restart.
 */
export async function pruneOrphanedWorktrees(): Promise<void> {
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

  // Restore staged backends for surviving previews
  if (_expressApp) {
    for (const prefix of activeWorktrees) {
      if (!activePreviews.has(prefix)) continue; // no dist to serve — skip
      const stagingDir = join(STAGING_PARENT, prefix);
      try {
        log(`Restoring staged backend for preview: ${prefix}`);
        const dataDir = seedStagingData(stagingDir);
        const { ctx, db: stagingDb } = await createStagingContext(stagingDir, dataDir);

        await ctx.sessionManager.initialize();

        const createRouter = (ctx as any)._createApiRouter;
        const stagedRouter = createRouter(ctx);
        activeStagingRouters.set(prefix, stagedRouter);

        activeStagingBackends.set(prefix, {
          ctx,
          router: stagedRouter,
          db: stagingDb,
          cleanup: async () => {
            try {
              await ctx.sessionManager.gracefulShutdown();
            } catch (err) {
              log(`Warning: staging SDK shutdown error: ${err}`);
            }
          },
        });

        log(`Restored staged backend for preview: ${prefix}`);
      } catch (err) {
        log(`Failed to restore staged backend for ${prefix}, cleaning up preview: ${err}`);
        // Clean up the broken preview entirely rather than leaving a half-working shell
        removeStagingDist(prefix);
        removeWorktree(stagingDir, `staging/${prefix}`);
      }
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

      // Ensure node_modules is ignored in the staging worktree (prevents accidental git add)
      ensureNodeModulesIgnored(stagingDir);

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

      // Install deps if staging package.json diverged from production
      ensureStagingDeps(stagingDir);

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
          const dataDir = seedStagingData(stagingDir);

          // Create staging AppContext from worktree code
          log(`Creating staging backend context from ${stagingDir}...`);
          const { ctx, db: stagingDb } = await createStagingContext(stagingDir, dataDir);

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
            db: stagingDb,
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
      "Commits changes in staging (if uncommitted changes exist), rebases the staging branch onto the latest production HEAD, " +
      "merges to main, signals the launcher to restart, and auto-cleans the worktree. " +
      "Supports retries: if a previous deploy failed due to rebase conflicts, resolve them in the staging worktree " +
      "(git rebase <prodBranch>, fix conflicts, git add + git rebase --continue) then call staging_deploy again — " +
      "it will skip the commit step and proceed to merge. " +
      "IMPORTANT: Do not make further tool calls after a successful deploy — the server will restart. " +
      "RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
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

      // Ensure node_modules is ignored before staging (prevents accidental commit of symlinks)
      ensureNodeModulesIgnored(stagingDir);

      // Stage and commit if there are uncommitted changes (skip on retry after conflict resolution)
      run("git add -A", stagingDir);
      const status = run("git --no-pager status --porcelain", stagingDir);
      const hasUncommittedChanges = status.ok && !!status.output.trim();

      if (hasUncommittedChanges) {
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
      }

      // Determine production branch
      const prodBranchResult = run("git rev-parse --abbrev-ref HEAD", PRODUCTION_ROOT);
      const prodBranch = prodBranchResult.ok ? prodBranchResult.output.trim() : "main";

      // Verify there are commits to merge
      const aheadCheck = run(`git log ${prodBranch}..${branch} --oneline`, PRODUCTION_ROOT);
      if (!aheadCheck.ok || !aheadCheck.output.trim()) {
        return { success: false, error: "Nothing to deploy — staging branch has no commits ahead of production." };
      }

      // Stash any uncommitted changes so they don't block pull/push
      const stashResult = run("git stash --include-untracked", PRODUCTION_ROOT);
      const didStash = stashResult.ok && !stashResult.output.includes("No local changes");
      if (didStash) {
        log("Stashed uncommitted production changes");
      }
      const unstashProduction = () => {
        if (didStash) {
          run("git stash pop", PRODUCTION_ROOT);
          log("Restored stashed production changes");
        }
      };

      // Pull latest production so the rebase target is current
      const pullResult = run(`git pull --rebase origin ${prodBranch}`, PRODUCTION_ROOT);
      if (pullResult.ok) {
        log("Pulled latest production from origin");
      } else {
        log(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
      }

      // Rebase staging branch onto updated production HEAD for a clean merge
      const rebaseResult = run(`git rebase ${prodBranch}`, stagingDir);
      if (!rebaseResult.ok) {
        run("git rebase --abort", stagingDir);
        unstashProduction();
        log(`Staging rebase failed — manual conflict resolution needed`);
        return {
          success: false,
          error:
            `Staging branch has conflicts with the latest production code. ` +
            `The rebase has been aborted and your staging worktree is intact.\n\n` +
            `To resolve (all commands run in the staging directory ${stagingDir}):\n` +
            `1. git rebase ${prodBranch}\n` +
            `2. Resolve conflicting files shown by git\n` +
            `3. git add <resolved-files>\n` +
            `4. git rebase --continue\n` +
            `5. Repeat steps 2-4 if there are more conflicts\n` +
            `6. Call staging_deploy again — it will skip the commit and proceed to merge\n\n` +
            rebaseResult.output.slice(-500),
        };
      }
      log("Staging branch rebased onto production");

      // Store pre-deploy SHA so the launcher can roll back to exactly this point
      const headResult = run("git rev-parse HEAD", PRODUCTION_ROOT);
      const preDeploySha = headResult.ok ? headResult.output.trim() : "";
      if (preDeploySha) {
        const dataDir = join(PRODUCTION_ROOT, "data");
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        writeFileSync(PRE_DEPLOY_SHA_FILE, preDeploySha);
        log(`Pre-deploy SHA saved: ${preDeploySha}`);
      }

      // Merge into production (should be fast-forward after rebase)
      const mergeResult = run(`git merge "${branch}" --no-edit`, PRODUCTION_ROOT);
      if (!mergeResult.ok) {
        run("git merge --abort", PRODUCTION_ROOT);
        unstashProduction();
        try { unlinkSync(PRE_DEPLOY_SHA_FILE); } catch {}
        return {
          success: false,
          error:
            `Merge failed after rebase (unexpected). The merge has been aborted.\n` +
            `Your staging worktree is still intact. Try running 'git rebase ${prodBranch}' ` +
            `in the staging directory to resolve conflicts, then call staging_deploy again.\n\n` +
            mergeResult.output.slice(-500),
        };
      }

      const newHead = run("git rev-parse --short HEAD", PRODUCTION_ROOT);
      const commitSha = newHead.ok ? newHead.output.trim() : "unknown";
      log(`Merged to production: ${commitSha}`);

      // Install deps if package.json or package-lock.json changed
      const pkgChanged = run(`git diff "${preDeploySha}" HEAD --name-only -- package.json package-lock.json`, PRODUCTION_ROOT);
      if (pkgChanged.ok && pkgChanged.output.trim()) {
        log("Package files changed — running npm install in production...");
        const npmResult = run("npm install --no-audit --no-fund", PRODUCTION_ROOT);
        if (!npmResult.ok) {
          log(`npm install failed (non-fatal): ${npmResult.output.slice(-300)}`);
        } else {
          log("npm install succeeded");
          // Update launcher deps hash so it doesn't re-install on restart
          try {
            const { createHash } = await import("node:crypto");
            const parts: string[] = [];
            for (const f of ["package.json", "package-lock.json"]) {
              const p = join(PRODUCTION_ROOT, f);
              parts.push(existsSync(p) ? readFileSync(p, "utf-8") : "");
            }
            const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
            const hashFile = join(PRODUCTION_ROOT, "data", "deps-hash");
            writeFileSync(hashFile, hash);
          } catch {}
        }
      }

      // Push to origin so other deployments can pick up the change
      let pushResult = run(`git push origin ${prodBranch}`, PRODUCTION_ROOT);
      if (!pushResult.ok) {
        // Push may fail if remote has new commits — pull --rebase and retry once
        log("Push failed, attempting pull --rebase before retry...");
        const retryRebase = run(`git pull --rebase origin ${prodBranch}`, PRODUCTION_ROOT);
        if (retryRebase.ok) {
          pushResult = run(`git push origin ${prodBranch}`, PRODUCTION_ROOT);
        }
      }
      if (pushResult.ok) {
        log("Pushed to origin");
      } else {
        log(`WARNING: Git push to origin failed — commits are local only. ` +
            `Run 'git push origin ${prodBranch}' manually. ${pushResult.output.slice(-200)}`);
      }

      unstashProduction();

      // Signal launcher to restart
      const dataDir = join(PRODUCTION_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      triggerRestartPending();
      log("Restart signal sent");

      // Cleanup staging worktree and branch (best-effort — deploy already succeeded)
      try {
        removeWorktree(stagingDir, branch);
        removeStagingDist(prefix);
        await teardownStagingBackend(prefix);
        log("Staging worktree cleaned up");
      } catch (err) {
        log(`Warning: post-deploy cleanup failed (non-fatal): ${err}`);
      }

      return {
        success: true,
        commitSha,
        message: `Deployed ${commitSha} to production. Restart signal sent — do NOT make any more tool calls.`,
      };
    },
  }),

  defineTool("staging_cleanup", {
    description: "Abandon a staging worktree and discard all changes. Use ONLY when you want to completely discard your work and start over — NOT for merge/rebase conflicts (resolve those in-place and retry staging_deploy instead). RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
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
