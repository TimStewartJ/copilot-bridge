// Per-session staging worktrees for validated code deployment
// Each session gets an isolated worktree to make changes, run quality checks,
// and deploy only after validation passes.

import { defineTool } from "@github/copilot-sdk";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { triggerRestartPending } from "./session-manager.js";
import { createDirectoryLink, removeDirectoryLink } from "./platform.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTION_ROOT = join(__dirname, "..", "..");
const STAGING_PARENT = join(PRODUCTION_ROOT, "..", "bridge-staging");
const STAGING_DIST_PARENT = join(PRODUCTION_ROOT, "dist", "staging");
const SIGNAL_FILE = join(PRODUCTION_ROOT, "data", "restart.signal");
const PRE_DEPLOY_SHA_FILE = join(PRODUCTION_ROOT, "data", "pre-deploy-sha");

/** Active staging previews: prefix → dist path */
const activePreviews = new Map<string, string>();

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
  // Clean up orphaned staging preview dist directories
  if (existsSync(STAGING_DIST_PARENT)) {
    try {
      const distEntries = readdirSync(STAGING_DIST_PARENT, { withFileTypes: true });
      for (const entry of distEntries) {
        if (!entry.isDirectory()) continue;
        log(`Pruning orphaned staging dist: ${entry.name}`);
        rmSync(join(STAGING_DIST_PARENT, entry.name), { recursive: true, force: true });
      }
    } catch (err) {
      log(`Warning: staging dist pruning failed: ${err}`);
    }
  }

  if (!existsSync(STAGING_PARENT)) return;

  try {
    const entries = readdirSync(STAGING_PARENT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stagingDir = join(STAGING_PARENT, entry.name);
      const branch = `staging/${entry.name}`;

      // Check if the branch still exists
      const branchCheck = run(`git rev-parse --verify "${branch}"`, PRODUCTION_ROOT);
      if (!branchCheck.ok) {
        log(`Pruning orphaned staging directory (no branch): ${stagingDir}`);
        removeWorktree(stagingDir, branch);
        continue;
      }

      log(`Found active staging worktree: ${stagingDir} (branch: ${branch})`);
    }

    run("git worktree prune", PRODUCTION_ROOT);
  } catch (err) {
    log(`Warning: orphan pruning failed: ${err}`);
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

      log(`Staging preview ready at ${basePath}`);
      return {
        success: true,
        previewPath: basePath,
        message:
          `Staging preview is live at ${basePath}. ` +
          `Share this URL with the user (append to tunnel URL) and wait for confirmation before deploying.`,
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

      // Signal launcher to restart
      const dataDir = join(PRODUCTION_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      triggerRestartPending();
      log("Restart signal sent");

      // Cleanup staging worktree and branch
      removeWorktree(stagingDir, branch);
      removeStagingDist(prefix);
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

      log("Staging worktree cleaned up");
      return { success: true, message: `Staging worktree removed: ${stagingDir}` };
    },
  }),
];
