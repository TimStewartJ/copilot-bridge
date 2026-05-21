// Per-session staging worktrees for validated code deployment
// Each session gets an isolated worktree to make changes, run quality checks,
// and deploy only after validation passes.

import { defineTool } from "@github/copilot-sdk";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type express from "express";
import { randomBytes } from "node:crypto";
import { dependencySyncHash, DEPENDENCY_SYNC_GIT_PATHSPEC, preparePatchedPackagesForInstall } from "./dependency-sync.js";
import { preserveOrCreateRollbackCheckpoint, removeRollbackCheckpointIfCreated } from "./pre-deploy-checkpoint.js";
import { isRestartPending } from "./session-manager.js";
import { requireToolHandlers } from "./tool-handler.js";
import {
  createDirectoryLink,
  killProcessTree,
  removeDirectoryLink,
} from "./platform.js";
import { buildPublicUrl } from "./tunnel.js";
import {
  DEPLOY_CHECK_COMMAND,
  DEPLOY_GATE,
  DEPLOY_GATE_VERSION,
  DEPLOY_SMOKE_GATE,
  PREVIEW_GATE,
  PREVIEW_GATE_COMMAND,
  PREVIEW_GATE_VERSION,
  STAGING_DEPLOY_GATE,
  runValidationGateAsync,
} from "./validation-pipeline.js";
import { writeDeployValidationStamp } from "./deploy-validation-stamp.js";
import {
  deleteStagingValidationStamp,
  readStagingValidationStamp,
  validateStagingValidationStamp,
  writeStagingValidationStamp,
} from "./staging-validation-stamp.js";
import { config } from "./config.js";
import {
  buildStagingBackendSpawnConfig,
  cleanupStagingBackendResources,
  createStagingProxyHandler,
  forgetStagingPreviewBackend,
  hasActiveStagingBackend,
  getStagingRouter,
  hasPendingStagingBackendStart,
  hasRegisteredExpressApp,
  hasStagingBackendState,
  initializeStagingBackend,
  registerExpressApp,
  rememberRestorablePreviewTarget,
  restoreStagingBackendWithRetry,
  scheduleStartupBackendWarmup,
  seedStagingData,
  startStagingBackendProcess,
  writeRestartSignalOrRollback,
  type RestoreStagingBackendWithRetryOptions,
  type SeedStagingDataOptions,
} from "./staging-backend-manager.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  FAILURE_DETAIL_OUTPUT_LIMIT,
  FAILURE_SESSION_LOG_OUTPUT_LIMIT,
  PRE_DEPLOY_SHA_FILE,
  PRODUCTION_DATA_DIR,
  PRODUCTION_ROOT,
  SIGNAL_FILE,
  STAGING_INSTALL_COMMAND,
  STAGING_INSTALL_TIMEOUT_MS,
  STAGING_PARENT,
  STAGING_PREVIEW_PARENT,
  STAGING_STALE_ARTIFACT_KEEP_RECENT,
  STAGING_STALE_ARTIFACT_MAX_AGE_MS,
  STAGING_STALE_ARTIFACT_RECENT_GRACE_MS,
  createPreviewTarget,
  directoryMtimeMs,
  listPreviewTargetsForStagingDir,
  listStagingPreviewParents,
  parsePreviewPrefix,
  previewTargetLastActivityMs,
  removeDirectoryWithRetries,
  removePreviewData,
  resolvePreviewProfile,
  shouldManageStagingArtifacts,
  uniqueResolvedPaths,
  type PreviewTarget,
  type StagingPreviewProfile,
} from "./staging-preview-shared.js";
import {
  joinFailureSections,
  truncateFailureText,
} from "./staging-command-utils.js";
import { prepareReleaseSlot } from "./release-slots.js";
import { log } from "./staging-log.js";
export { buildPreviewPrefix } from "./staging-preview-shared.js";
export { parsePreviewPrefix, shouldManageStagingArtifacts } from "./staging-preview-shared.js";
export { getStagingRouter, registerExpressApp } from "./staging-backend-manager.js";
import { toolFailure } from "./tool-results.js";
import {
  extractCommandFailureLogPath,
  extractCommandFailureLogWriteError,
  formatCommandDuration,
} from "./validation-command-log.js";
import { createValidationCommandEnv, prependNodePath } from "./validation-command-env.js";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";
import { runValidationCommand } from "./validation-command-runner.js";


async function cleanupPreviewArtifactsForStagingDir(stagingDir: string): Promise<void> {
  for (const target of listPreviewTargetsForStagingDir(stagingDir)) {
    await cleanupPreviewTarget(stagingDir, target.profile);
  }
}

async function cleanupPreviewResources(
  prefix: string,
  options: { removeDist?: boolean; removeData?: boolean } = {},
): Promise<void> {
  const removeDist = options.removeDist ?? true;
  const ownedByThisProcess = activePreviews.has(prefix) || hasStagingBackendState(prefix);
  if (!ownedByThisProcess) return;

  await cleanupStagingBackendResources(prefix, { removeData: options.removeData });
  if (removeDist) {
    removeStagingDist(prefix);
  }
}

export async function cleanupPreviewTarget(
  stagingDir: string,
  profile: StagingPreviewProfile = "clone",
  options: { removeData?: boolean } = {},
): Promise<void> {
  const target = createPreviewTarget(stagingDir, profile);
  await cleanupPreviewResources(target.prefix, options);
}

/**
 * Compare dependency inputs between staging and production.
 * If package files or patch-package files differ, replace the node_modules
 * symlink with a real npm install so builds use the correct dependency state.
 */
async function ensureStagingDeps(stagingDir: string): Promise<{ ok: boolean; command?: string; output?: string }> {
  if (dependencySyncHash(stagingDir) === dependencySyncHash(PRODUCTION_ROOT)) {
    return { ok: true };
  }

  log("Staging dependency inputs differ from production — installing dependencies in staging...");

  // If node_modules is a symlink/junction, remove it so npm can create a real directory.
  // If it's already a real directory, leave it — npm install is incremental.
  const stagingModules = join(stagingDir, "node_modules");
  if (existsSync(stagingModules)) {
    try {
      const stat = lstatSync(stagingModules);
      if (stat.isSymbolicLink()) {
        removeDirectoryLink(stagingModules, PRODUCTION_ROOT);
        log("Removed node_modules symlink for fresh install");
      } else {
        log("node_modules is a real directory — running incremental install");
      }
    } catch {
      // lstat failed — try to proceed anyway
    }
  }

  const prepared = preparePatchedPackagesForInstall(stagingDir);
  if (prepared.packages.length > 0) {
    log(`Prepared patched packages for staging install: ${prepared.packages.join(", ")}`);
  }

  const installResult = await run(STAGING_INSTALL_COMMAND, stagingDir, {
    timeoutMs: STAGING_INSTALL_TIMEOUT_MS,
  });
  if (installResult.ok) {
    prepared.discard();
    log("Staging npm install succeeded");
    return { ok: true };
  }
  prepared.restore();
  log(`Staging npm install failed: ${installResult.output.slice(-300)}`);
  return { ok: false, command: STAGING_INSTALL_COMMAND, output: installResult.output };
}

/** Active staging previews: prefix -> dist path */
const activePreviews = new Map<string, string>();

/** Returns the map of active staging previews for the Express middleware to use. */
export function getActivePreviews(): ReadonlyMap<string, string> {
  return activePreviews;
}

type RegisterExistingPreviewsFromDiskOptions = {
  stagingParent?: string;
  stagingDistParent?: string;
  stagingPreviewParents?: string[];
  activePreviewMap?: Map<string, string>;
  expressApp?: express.Application | null;
  log?: (msg: string) => void;
};

function createRestorablePreviewTarget(
  stagingParent: string,
  prefix: string,
  profile: StagingPreviewProfile,
  outDir: string,
): PreviewTarget {
  return {
    ...createPreviewTarget(join(stagingParent, prefix), profile),
    outDir,
    updatedAtMs: directoryMtimeMs(outDir),
  };
}

/**
 * Cheap startup discovery for already-built previews. This runs before listen()
 * so restored preview URLs are routeable while heavier prune/warmup work stays async.
 */
export function registerExistingPreviewsFromDisk(options: RegisterExistingPreviewsFromDiskOptions = {}): number {
  const writeLog = options.log ?? log;
  if (!shouldManageStagingArtifacts()) {
    return 0;
  }

  const stagingParent = options.stagingParent ?? STAGING_PARENT;
  const stagingPreviewParents = options.stagingPreviewParents
    ?? (options.stagingDistParent ? [options.stagingDistParent] : listStagingPreviewParents());
  const previewMap = options.activePreviewMap ?? activePreviews;
  const shouldRegisterBackends = options.expressApp === undefined
    ? hasRegisteredExpressApp()
    : options.expressApp !== null;
  let registeredPreviewDirs = 0;

  for (const stagingPreviewParent of uniqueResolvedPaths(stagingPreviewParents)) {
    if (!existsSync(stagingPreviewParent)) continue;
    try {
      const distEntries = readdirSync(stagingPreviewParent, { withFileTypes: true });
      for (const entry of distEntries) {
        if (!entry.isDirectory()) continue;
        const parsed = parsePreviewPrefix(entry.name);
        if (!parsed) continue;

        const distDir = join(stagingPreviewParent, entry.name);
        if (!existsSync(join(distDir, "index.html"))) continue;

        if (!previewMap.has(entry.name)) {
          const target = createRestorablePreviewTarget(
            stagingParent,
            parsed.stagingName,
            parsed.profile,
            distDir,
          );
          previewMap.set(entry.name, distDir);
          if (shouldRegisterBackends) {
            rememberRestorablePreviewTarget(target);
          }
          registeredPreviewDirs++;
        }
      }
    } catch (err) {
      writeLog(`Warning: staging preview startup discovery failed: ${err}`);
    }
  }

  if (registeredPreviewDirs > 0) {
    writeLog(`Registered ${registeredPreviewDirs} staging preview route(s) from disk before pruning`);
  }
  return registeredPreviewDirs;
}


function removeStagingDist(prefix: string): void {
  for (const previewParent of listStagingPreviewParents()) {
    const distDir = join(previewParent, prefix);
    if (existsSync(distDir)) {
      removeDirectoryWithRetries(distDir);
    }
  }
  activePreviews.delete(prefix);
}

async function run(
  cmd: string,
  cwd: string,
  options: { timeoutMs?: number; isolateRuntimeEnv?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; output: string }> {
  // Prepend the running process's Node directory to PATH so npx/vitest/tsc/vite
  // resolve the correct Node binary (v22+ required for node:sqlite) instead of
  // whatever older `node` happens to be first on the system PATH.
  const nodeDir = dirname(process.execPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const validationEnv = options.isolateRuntimeEnv
    ? createValidationCommandEnv(process.env, { nodeDir, prefix: "bridge-staging-validation-" })
    : undefined;
  const baseEnv = validationEnv?.env ?? prependNodePath(process.env, nodeDir);
  const env = withNonInteractiveCommandEnv({ ...baseEnv, ...options.env });
  try {
    return await runValidationCommand({
      rootDir: PRODUCTION_ROOT,
      source: "staging",
      command: cmd,
      cwd,
      env,
      timeoutMs,
      killProcessTree,
      failureOutputFormat: "plain",
    });
  } finally {
    validationEnv?.cleanup();
  }
}

function stagingFailure(
  summary: string,
  detail: string,
  options: { sessionLog?: string; toolTelemetry?: Record<string, unknown> } = {},
) {
  return toolFailure(summary, {
    detail,
    sessionLog: options.sessionLog ?? detail,
    toolTelemetry: options.toolTelemetry,
  });
}

function commandFailure(
  summary: string,
  detail: string,
  command: string,
  cwd: string,
  output: string,
  toolTelemetry: Record<string, unknown> = {},
) {
  const combinedDetail = joinFailureSections(detail, truncateFailureText(output, FAILURE_DETAIL_OUTPUT_LIMIT)) ?? detail;
  const validationLogPath = extractCommandFailureLogPath(output);
  const validationLogWriteError = extractCommandFailureLogWriteError(output);
  return stagingFailure(summary, combinedDetail, {
    sessionLog: joinFailureSections(
      detail,
      `Command: ${command}`,
      `Working directory: ${cwd}`,
      truncateFailureText(output, FAILURE_SESSION_LOG_OUTPUT_LIMIT),
    ),
    toolTelemetry: {
      command,
      cwd,
      ...(validationLogPath ? { validationLogPath } : {}),
      ...(validationLogWriteError ? { validationLogWriteError } : {}),
      ...toolTelemetry,
    },
  });
}

function deployValidationEnv(): NodeJS.ProcessEnv {
  return {
    BRIDGE_VALIDATION_LOG_DIR: join(PRODUCTION_DATA_DIR, "validation-logs"),
  };
}

async function listStagingBranchPrefixes(): Promise<Set<string> | null> {
  const branchList = await run('git branch --format="%(refname:short)" --list "staging/*"', PRODUCTION_ROOT);
  if (!branchList.ok) {
    log(`Warning: could not list staging branches: ${branchList.output.slice(-200)}`);
    return null;
  }
  return new Set(
    branchList.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => name.replace(/^staging\//, "")),
  );
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

/** Remove a staging worktree and its branch. Handles node_modules cleanup. */
async function removeWorktree(stagingDir: string, branch: string): Promise<void> {
  // Remove node_modules first — git worktree remove can't handle symlinks or large dirs
  const junctionPath = join(stagingDir, "node_modules");
  if (existsSync(junctionPath)) {
    try {
      const stat = lstatSync(junctionPath);
      if (stat.isSymbolicLink()) {
        rmSync(junctionPath);
      } else if (stat.isDirectory()) {
        rmSync(junctionPath, { recursive: true, force: true });
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") log(`Warning: failed to remove node_modules: ${err.message}`);
    }
  }
  await run(`git worktree remove "${stagingDir}" --force`, PRODUCTION_ROOT);
  await run(`git branch -D "${branch}"`, PRODUCTION_ROOT);
  await run("git worktree prune", PRODUCTION_ROOT);
}

async function worktreeHasUncommittedChanges(stagingDir: string): Promise<boolean> {
  const status = await run("git --no-pager status --porcelain", stagingDir, { timeoutMs: 30_000 });
  if (!status.ok) return true;
  return status.output.trim().length > 0;
}

async function pruneStaleStagingArtifacts(options: {
  stagingParent: string;
  activeWorktrees: Set<string>;
  restorablePreviews: Map<string, PreviewTarget>;
  previewMap: Map<string, string>;
  removeWorktree: (stagingDir: string, branch: string) => void | Promise<void>;
  log: (msg: string) => void;
}): Promise<number> {
  if (STAGING_STALE_ARTIFACT_MAX_AGE_MS <= 0) return 0;

  const byStagingName = new Map<string, PreviewTarget[]>();
  for (const target of options.restorablePreviews.values()) {
    const parsed = parsePreviewPrefix(target.prefix);
    if (!parsed) continue;
    byStagingName.set(parsed.stagingName, [...(byStagingName.get(parsed.stagingName) ?? []), target]);
  }

  const entries = Array.from(options.activeWorktrees).map((prefix) => {
    const stagingDir = join(options.stagingParent, prefix);
    const targets = byStagingName.get(prefix) ?? [];
    const previewActivityMs = targets.reduce(
      (latest, target) => Math.max(latest, previewTargetLastActivityMs(target)),
      0,
    );
    return {
      prefix,
      stagingDir,
      branch: `staging/${prefix}`,
      targets,
      activityMs: Math.max(directoryMtimeMs(stagingDir), previewActivityMs),
    };
  }).sort((a, b) => b.activityMs - a.activityMs);

  const protectedPrefixes = new Set(
    entries.slice(0, STAGING_STALE_ARTIFACT_KEEP_RECENT).map((entry) => entry.prefix),
  );
  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    if (protectedPrefixes.has(entry.prefix)) continue;
    if (now - entry.activityMs < STAGING_STALE_ARTIFACT_MAX_AGE_MS) continue;
    if (now - directoryMtimeMs(entry.stagingDir) < STAGING_STALE_ARTIFACT_RECENT_GRACE_MS) continue;
    if (hasActiveStagingBackend(entry.prefix) || hasPendingStagingBackendStart(entry.prefix)) continue;
    if (await worktreeHasUncommittedChanges(entry.stagingDir)) {
      options.log(`Skipping stale staging worktree with local changes: ${entry.prefix}`);
      continue;
    }

    await cleanupPreviewArtifactsForStagingDir(entry.stagingDir);
    await options.removeWorktree(entry.stagingDir, entry.branch);
    options.activeWorktrees.delete(entry.prefix);
    for (const target of entry.targets) {
      options.previewMap.delete(target.prefix);
      options.restorablePreviews.delete(target.prefix);
      forgetStagingPreviewBackend(target.prefix);
    }
    removed++;
  }

  return removed;
}

type PruneOrphanedWorktreesOptions = {
  stagingParent?: string;
  stagingDistParent?: string;
  stagingPreviewParents?: string[];
  activePreviewMap?: Map<string, string>;
  expressApp?: express.Application | null;
  listBranchPrefixes?: () => Set<string> | null | Promise<Set<string> | null>;
  removeWorktree?: (stagingDir: string, branch: string) => void | Promise<void>;
  log?: (msg: string) => void;
  pruneGitWorktrees?: () => void | Promise<void>;
};

/**
 * Prune orphaned staging worktrees on server startup and register surviving previews.
 * Called from server initialization — removes worktrees whose branches
 * no longer exist. Backends are restored lazily, with a small newest-preview warmup.
 */
async function pruneOrphanedWorktreesImpl(options: PruneOrphanedWorktreesOptions = {}): Promise<void> {
  const writeLog = options.log ?? log;
  if (!shouldManageStagingArtifacts()) {
    writeLog("Release mode — skipping staging worktree pruning and preview restore");
    return;
  }

  const stagingParent = options.stagingParent ?? STAGING_PARENT;
  const stagingPreviewParents = options.stagingPreviewParents
    ?? (options.stagingDistParent ? [options.stagingDistParent] : listStagingPreviewParents());
  const previewMap = options.activePreviewMap ?? activePreviews;
  const shouldRegisterBackends = options.expressApp === undefined
    ? hasRegisteredExpressApp()
    : options.expressApp !== null;
  const getBranchPrefixes = options.listBranchPrefixes ?? listStagingBranchPrefixes;
  const removeOrphanedWorktree = options.removeWorktree ?? removeWorktree;
  const pruneGitWorktrees = options.pruneGitWorktrees ?? (async () => {
    await run("git worktree prune", PRODUCTION_ROOT);
  });

  // Collect active staging prefixes (worktrees with valid branches)
  const activeWorktrees = new Set<string>();
  const restorablePreviews = new Map<string, PreviewTarget>();
  const activeBranchPrefixes = await getBranchPrefixes();
  const skipOrphanPrune = activeBranchPrefixes === null;
  let orphanedWorktreeDirs = 0;
  let restoredPreviewDirs = 0;
  let orphanedPreviewDirs = 0;

  if (existsSync(stagingParent)) {
    try {
      const entries = readdirSync(stagingParent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stagingDir = join(stagingParent, entry.name);
        const branch = `staging/${entry.name}`;

        if (skipOrphanPrune) {
          activeWorktrees.add(entry.name);
          continue;
        }

        if (!activeBranchPrefixes.has(entry.name)) {
          await removeOrphanedWorktree(stagingDir, branch);
          orphanedWorktreeDirs++;
          continue;
        }

        activeWorktrees.add(entry.name);
      }

      if (!skipOrphanPrune) {
        await pruneGitWorktrees();
      }
    } catch (err) {
      writeLog(`Warning: orphan pruning failed: ${err}`);
    }
  }

  // Clean up orphaned staging preview directories, but keep ones with active worktrees.
  for (const stagingPreviewParent of uniqueResolvedPaths(stagingPreviewParents)) {
    if (!existsSync(stagingPreviewParent)) continue;
    try {
      const distEntries = readdirSync(stagingPreviewParent, { withFileTypes: true });
      for (const entry of distEntries) {
        if (!entry.isDirectory()) continue;
        const parsed = parsePreviewPrefix(entry.name, activeWorktrees);
        if (parsed) {
          const distDir = join(stagingPreviewParent, entry.name);
          if (!restorablePreviews.has(entry.name)) {
            const target = createRestorablePreviewTarget(
              stagingParent,
              parsed.stagingName,
              parsed.profile,
              distDir,
            );
            previewMap.set(entry.name, distDir);
            restorablePreviews.set(entry.name, target);
            restoredPreviewDirs++;
          }
        } else if (!skipOrphanPrune) {
          rmSync(join(stagingPreviewParent, entry.name), { recursive: true, force: true });
          previewMap.delete(entry.name);
          forgetStagingPreviewBackend(entry.name);
          orphanedPreviewDirs++;
        }
      }
    } catch (err) {
      writeLog(`Warning: staging dist pruning failed: ${err}`);
    }
  }

  if (orphanedWorktreeDirs > 0 || restoredPreviewDirs > 0 || orphanedPreviewDirs > 0) {
    writeLog(
      `Staging prune summary: ${activeWorktrees.size} active worktree(s), ` +
        `${restoredPreviewDirs} preview dir(s) registered, ` +
        `${orphanedWorktreeDirs} orphan worktree dir(s) removed, ` +
        `${orphanedPreviewDirs} orphan preview dir(s) removed`,
    );
  }

  if (skipOrphanPrune) {
    writeLog("Skipping orphan staging prune because the staging branch snapshot is unavailable");
  }

  if (!skipOrphanPrune) {
    const staleRemoved = await pruneStaleStagingArtifacts({
      stagingParent,
      activeWorktrees,
      restorablePreviews,
      previewMap,
      removeWorktree: removeOrphanedWorktree,
      log: writeLog,
    });
    if (staleRemoved > 0) {
      writeLog(`Removed ${staleRemoved} stale staging worktree(s)`);
    }
  }

  // Register staged backends for lazy restore, then warm only the newest few.
  if (shouldRegisterBackends) {
    for (const target of restorablePreviews.values()) {
      if (!previewMap.has(target.prefix)) continue;
      rememberRestorablePreviewTarget(target);
    }
    scheduleStartupBackendWarmup(Array.from(restorablePreviews.values()), (prefix) => activePreviews.has(prefix), writeLog);
  }
}

export async function pruneOrphanedWorktrees(): Promise<void> {
  await pruneOrphanedWorktreesImpl();
}

export const __testing = {
  seedStagingData(stagingDir: string, options: SeedStagingDataOptions = {}) {
    return seedStagingData(stagingDir, options).dataDir;
  },
  startStagingBackendProcess,
  createStagingProxyHandler,
  buildStagingBackendSpawnConfig,
  restoreStagingBackendWithRetry,
  writeRestartSignalOrRollback,
  listStagingBranchPrefixes,
  pruneOrphanedWorktreesImpl,
  getStagingPreviewParent: () => STAGING_PREVIEW_PARENT,
  listStagingPreviewParents,
};

export const STAGING_TOOLS = requireToolHandlers([
  defineTool("staging_init", {
    description:
      "Create a fresh staging worktree for making code changes to the bridge. " +
      "Returns the staging directory path where you should make all edits. " +
      "Use npm run check:fast plus the focused check lane that matches your edit while iterating, then npm run check:pr before calling staging_preview or staging_deploy.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const prefix = randomBytes(4).toString("hex");
      const stagingDir = join(STAGING_PARENT, prefix);
      const branch = `staging/${prefix}`;

      log(`Creating staging worktree: ${stagingDir} (branch: ${branch})`);

      // Pull latest from origin so the worktree starts from the newest remote state
      const currentBranch = await run("git rev-parse --abbrev-ref HEAD", PRODUCTION_ROOT);
      const branchName = currentBranch.ok ? currentBranch.output.trim() : "main";
      const pullResult = await run(`git pull --rebase origin ${branchName}`, PRODUCTION_ROOT);
      if (pullResult.ok) {
        log("Pulled latest from origin");
      } else {
        log(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
      }

      if (!existsSync(STAGING_PARENT)) {
        mkdirSync(STAGING_PARENT, { recursive: true });
      }

      // Create branch from current HEAD
      const branchResult = await run(`git branch "${branch}"`, PRODUCTION_ROOT);
      if (!branchResult.ok) {
        return commandFailure(
          "Failed to create staging branch.",
          `Failed to create branch ${branch} for a new staging worktree.`,
          `git branch "${branch}"`,
          PRODUCTION_ROOT,
          branchResult.output,
          { branch, stagingDir },
        );
      }

      // Create worktree
      const wtResult = await run(`git worktree add "${stagingDir}" "${branch}"`, PRODUCTION_ROOT);
      if (!wtResult.ok) {
        await run(`git branch -D "${branch}"`, PRODUCTION_ROOT);
        return commandFailure(
          "Failed to create staging worktree.",
          `Failed to create worktree ${stagingDir} from branch ${branch}.`,
          `git worktree add "${stagingDir}" "${branch}"`,
          PRODUCTION_ROOT,
          wtResult.output,
          { branch, stagingDir },
        );
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

      try {
        deleteStagingValidationStamp(PRODUCTION_DATA_DIR, prefix);
      } catch (error) {
        log(`Warning: could not clear stale staging validation stamp for ${prefix}: ${error instanceof Error ? error.message : String(error)}`);
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
        validate: {
          type: "boolean",
          description: "Run preview validation before building. Defaults to true; preview smoke can pass false after validation has already happened.",
        },
      },
      required: ["stagingDir"],
    },
    handler: async (args: any) => {
      const { stagingDir } = args;
      const profile = resolvePreviewProfile(args.profile);
      const shouldValidate = args.validate !== false;

      if (!existsSync(stagingDir)) {
        return stagingFailure(
          "Staging directory not found.",
          `Staging directory not found: ${stagingDir}. Call staging_init first.`,
          {
            sessionLog: `Missing staging directory: ${stagingDir}`,
            toolTelemetry: { stagingDir },
          },
        );
      }

      const target = createPreviewTarget(stagingDir, profile);
      const { prefix, basePath, outDir } = target;

      log(`Building ${profile} staging preview: ${stagingDir} → ${outDir} (base: ${basePath})`);

      const previewParent = dirname(outDir);
      if (!existsSync(previewParent)) {
        mkdirSync(previewParent, { recursive: true });
      }

      // Install deps if staging package.json diverged from production
      const depsResult = await ensureStagingDeps(stagingDir);
      if (!depsResult.ok) {
        return commandFailure(
          "Staging dependency install failed.",
          "Staging dependency inputs changed and npm install failed. Fix the staging worktree dependencies and retry.",
          depsResult.command!,
          stagingDir,
          depsResult.output!,
          { stagingDir },
        );
      }

      if (shouldValidate) {
        const preValidationHead = await run("git rev-parse HEAD", stagingDir);
        const preValidationCommitSha = preValidationHead.ok ? preValidationHead.output.trim() : "";
        const preValidationDependencyHash = dependencySyncHash(stagingDir);
        const validationResult = await runValidationGateAsync(PREVIEW_GATE, {
          cwd: stagingDir,
          run: (command, options) => run(command, stagingDir, options),
          log,
        });
        if (!validationResult.ok) {
          return commandFailure(
            "Staging preview validation failed.",
            "The staged changes did not pass the preview validation gate.",
            validationResult.step.command,
            stagingDir,
            validationResult.result.output,
            { stagingDir, gateId: validationResult.gate.id },
          );
        }
        const postValidationHead = await run("git rev-parse HEAD", stagingDir);
        const postValidationCommitSha = postValidationHead.ok ? postValidationHead.output.trim() : "";
        const postValidationDependencyHash = dependencySyncHash(stagingDir);
        if (
          preValidationCommitSha
          && postValidationCommitSha
          && preValidationCommitSha === postValidationCommitSha
          && preValidationDependencyHash === postValidationDependencyHash
        ) {
          try {
            writeStagingValidationStamp(PRODUCTION_DATA_DIR, {
              stagingPrefix: prefix,
              stagingCommitSha: postValidationCommitSha,
              dependencyHash: postValidationDependencyHash,
              gateId: PREVIEW_GATE.id,
              gateVersion: PREVIEW_GATE_VERSION,
              command: PREVIEW_GATE_COMMAND,
              source: "staging_preview",
              validatedAt: new Date().toISOString(),
            });
            log(`Staging preview validation stamp written for ${prefix} at ${postValidationCommitSha}`);
          } catch (error) {
            log(`Staging preview validation stamp could not be written; deploy will run the full gate: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          const reason = !preValidationCommitSha
            ? `staging HEAD could not be read before validation: ${preValidationHead.ok ? "empty git rev-parse output" : preValidationHead.output.slice(-200)}`
            : !postValidationCommitSha
              ? `staging HEAD could not be read after validation: ${postValidationHead.ok ? "empty git rev-parse output" : postValidationHead.output.slice(-200)}`
              : preValidationCommitSha !== postValidationCommitSha
                ? `staging HEAD changed during validation (${preValidationCommitSha} -> ${postValidationCommitSha})`
                : "dependency inputs changed during validation";
          log(`Staging preview validation stamp skipped because ${reason}`);
        }
      } else {
        log("Skipping staging preview validation");
      }

      // Build the client with the staging base path
      const buildResult = await run(
        `npx vite build --base "${basePath}" --outDir "${outDir}" --emptyOutDir`,
        stagingDir,
      );
      if (!buildResult.ok) {
        return commandFailure(
          "Staging preview build failed.",
          `Vite could not build the staging preview for ${basePath}.`,
          `npx vite build --base "${basePath}" --outDir "${outDir}" --emptyOutDir`,
          stagingDir,
          buildResult.output,
          { stagingDir, previewPath: basePath, outDir },
        );
      }

      // Register the preview for Express to serve
      activePreviews.set(prefix, outDir);
      rememberRestorablePreviewTarget(target);

      // ── Staged backend ──────────────────────────────────────────
      let backendReady = false;
      let backendError: string | undefined;

      if (hasRegisteredExpressApp()) {
        try {
          await initializeStagingBackend(prefix, stagingDir, profile);
          backendReady = true;
        } catch (err) {
          backendError = err instanceof Error ? err.message : String(err);
          await cleanupPreviewResources(prefix, { removeDist: false });
          log(`Staging backend failed (frontend-only preview): ${backendError}`);
        }
      } else {
        log("Express app not registered — frontend-only preview");
      }

      const fullUrl = buildPublicUrl(basePath) ?? null;
      const localUrl = `http://localhost:${config.web.port}${basePath}`;

      const backendNote = backendReady
        ? " Backend API is live at the same path (/api routes)."
        : backendError
          ? ` Backend failed to start: ${backendError}. Frontend-only preview.`
          : " Frontend-only preview (no Express app registered).";

      log(`Staging preview ready at ${fullUrl || localUrl}`);
      return {
        success: true,
        profile,
        previewPath: basePath,
        previewUrl: fullUrl,
        localUrl,
        backendReady,
        backendError,
        message: (fullUrl
          ? `Staging preview is live at ${fullUrl} (also available locally at ${localUrl}) — share this link with the user and wait for confirmation before deploying.`
          : `Staging preview is live locally at ${localUrl} — share this link with the user and wait for confirmation before deploying.`) + backendNote,
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
      "IMPORTANT: After a successful deploy, do not make further tool calls because the server will restart. " +
      "Status/progress-only tool calls may be batched with staging_deploy in the same tool-calling message; do not create no-op companion tool calls solely to satisfy tool-batching guidance. " +
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
      const deployStartedAt = Date.now();

      if (!existsSync(stagingDir)) {
        return stagingFailure(
          "Staging directory not found.",
          `Staging directory not found: ${stagingDir}. Call staging_init first.`,
          {
            sessionLog: `Missing staging directory: ${stagingDir}`,
            toolTelemetry: { stagingDir },
          },
        );
      }

      if (isRestartPending() || existsSync(SIGNAL_FILE)) {
        return stagingFailure(
          "A restart is already pending.",
          "A restart is already pending. Wait for it to complete before deploying.",
          { toolTelemetry: { stagingDir, signalFile: SIGNAL_FILE } },
        );
      }

      const prefix = basename(stagingDir);
      const branch = `staging/${prefix}`;

      log(`Deploying from ${stagingDir} (branch: ${branch})`);

      // Ensure node_modules is ignored before staging (prevents accidental commit of symlinks)
      ensureNodeModulesIgnored(stagingDir);

      // Stage and commit if there are uncommitted changes (skip on retry after conflict resolution)
      await run("git add -A", stagingDir);
      const status = await run("git --no-pager status --porcelain", stagingDir);
      const hasUncommittedChanges = status.ok && !!status.output.trim();

      if (hasUncommittedChanges) {
        const msgFile = join(stagingDir, ".commit-msg");
        try {
          writeFileSync(
            msgFile,
            `${message}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n`,
          );
          const commitResult = await run(`git commit -F "${msgFile}"`, stagingDir);
          if (!commitResult.ok) {
            return commandFailure(
              "Failed to commit staged changes.",
              "Failed to create the staging deploy commit. Resolve the git issue and retry.",
              `git commit -F "${msgFile}"`,
              stagingDir,
              commitResult.output,
              { stagingDir, branch },
            );
          }
        } finally {
          try { unlinkSync(msgFile); } catch {}
        }
      }

      // Determine production branch
      const prodBranchResult = await run("git rev-parse --abbrev-ref HEAD", PRODUCTION_ROOT);
      const prodBranch = prodBranchResult.ok ? prodBranchResult.output.trim() : "main";

      // Verify there are commits to merge
      const aheadCheck = await run(`git log ${prodBranch}..${branch} --oneline`, PRODUCTION_ROOT);
      if (!aheadCheck.ok) {
        return commandFailure(
          "Failed to compare staging changes with production.",
          `Failed to verify whether ${branch} is ahead of ${prodBranch}.`,
          `git log ${prodBranch}..${branch} --oneline`,
          PRODUCTION_ROOT,
          aheadCheck.output,
          { stagingDir, branch, prodBranch },
        );
      }
      if (!aheadCheck.output.trim()) {
        return stagingFailure(
          "Nothing to deploy from this staging worktree.",
          `Nothing to deploy — ${branch} has no commits ahead of ${prodBranch}.`,
          {
            sessionLog: joinFailureSections(
              `Nothing to deploy — ${branch} has no commits ahead of ${prodBranch}.`,
              `Command: git log ${prodBranch}..${branch} --oneline`,
              `Working directory: ${PRODUCTION_ROOT}`,
              "(no commits returned)",
            ),
            toolTelemetry: { stagingDir, branch, prodBranch },
          },
        );
      }

      // Stash any uncommitted changes so they don't block pull/push
      const stashResult = await run("git stash --include-untracked", PRODUCTION_ROOT);
      const didStash = stashResult.ok && !stashResult.output.includes("No local changes");
      if (didStash) {
        log("Stashed uncommitted production changes");
      }
      const unstashProduction = async () => {
        if (didStash) {
          await run("git stash pop", PRODUCTION_ROOT);
          log("Restored stashed production changes");
        }
      };

      // Pull latest production so the rebase target is current
      const pullResult = await run(`git pull --rebase origin ${prodBranch}`, PRODUCTION_ROOT);
      if (pullResult.ok) {
        log("Pulled latest production from origin");
      } else {
        log(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
      }

      // Rebase staging branch onto updated production HEAD for a clean merge
      const rebaseResult = await run(`git rebase ${prodBranch}`, stagingDir);
      if (!rebaseResult.ok) {
        await run("git rebase --abort", stagingDir);
        await unstashProduction();
        log(`Staging rebase failed — manual conflict resolution needed`);
        return commandFailure(
          "Staging branch conflicts with production.",
          `Staging branch has conflicts with the latest production code. ` +
            `The rebase has been aborted and your staging worktree is intact.\n\n` +
            `To resolve (all commands run in the staging directory ${stagingDir}):\n` +
            `1. git rebase ${prodBranch}\n` +
            `2. Resolve conflicting files shown by git\n` +
            `3. git add <resolved-files>\n` +
            `4. git rebase --continue\n` +
            `5. Repeat steps 2-4 if there are more conflicts\n` +
            `6. Call staging_deploy again — it will skip the commit and proceed to merge`,
          `git rebase ${prodBranch}`,
          stagingDir,
          rebaseResult.output,
          { stagingDir, branch, prodBranch },
        );
      }
      log("Staging branch rebased onto production");

      const depsResult = await ensureStagingDeps(stagingDir);
      if (!depsResult.ok) {
        await unstashProduction();
        return commandFailure(
          "Staging dependency install failed.",
          "Staging dependency inputs changed after rebase and npm install failed. The rebased staging worktree is still intact for retry-after-fix.",
          depsResult.command!,
          stagingDir,
          depsResult.output!,
          { stagingDir, branch, prodBranch },
        );
      }

      let validatedCommitSha = "";
      let dependencyHash: string | null = null;
      const stagingStamp = readStagingValidationStamp(PRODUCTION_DATA_DIR, prefix);
      let stagingValidation: ReturnType<typeof validateStagingValidationStamp> = {
        valid: false,
        reason: "missing staging validation stamp",
      };
      if (stagingStamp) {
        const candidateHeadResult = await run("git rev-parse HEAD", stagingDir);
        const candidateCommitSha = candidateHeadResult.ok ? candidateHeadResult.output.trim() : "";
        if (candidateCommitSha) {
          dependencyHash = dependencySyncHash(stagingDir);
          stagingValidation = validateStagingValidationStamp(stagingStamp, {
            stagingPrefix: prefix,
            stagingCommitSha: candidateCommitSha,
            dependencyHash,
            gateId: PREVIEW_GATE.id,
            gateVersion: PREVIEW_GATE_VERSION,
            command: PREVIEW_GATE_COMMAND,
          });
          if (stagingValidation.valid) {
            validatedCommitSha = candidateCommitSha;
          }
        } else {
          log(`Preview validation stamp not used: staging HEAD could not be read (${candidateHeadResult.ok ? "empty git rev-parse output" : candidateHeadResult.output.slice(-200)})`);
        }
      }
      const deployGate = stagingValidation.valid ? DEPLOY_SMOKE_GATE : STAGING_DEPLOY_GATE;
      if (stagingValidation.valid) {
        log(`Preview validation stamp matched for ${prefix} at ${validatedCommitSha} — running smoke-only deploy validation`);
      } else {
        log(`Preview validation stamp not used: ${stagingValidation.reason}`);
      }

      const validationResult = await runValidationGateAsync(deployGate, {
        cwd: stagingDir,
        run: (command, options) => run(command, stagingDir, { ...options, env: deployValidationEnv() }),
        log,
      });
      if (!validationResult.ok) {
        await unstashProduction();
        return commandFailure(
          "Staging deploy validation failed.",
          "The rebased staging worktree did not pass the deploy validation gate. The staging worktree is still intact for retry-after-fix.",
          validationResult.step.command,
          stagingDir,
          validationResult.result.output,
          { stagingDir, branch, prodBranch, gateId: validationResult.gate.id },
        );
      }
      if (!validatedCommitSha) {
        const validatedHeadResult = await run("git rev-parse HEAD", stagingDir);
        if (!validatedHeadResult.ok) {
          await unstashProduction();
          return commandFailure(
            "Failed to identify the validated staging commit.",
            "Deploy validation passed, but the staging commit SHA could not be read. The staging worktree is still intact for retry.",
            "git rev-parse HEAD",
            stagingDir,
            validatedHeadResult.output,
            { stagingDir, branch, prodBranch },
          );
        }
        validatedCommitSha = validatedHeadResult.output.trim();
        if (!validatedCommitSha) {
          await unstashProduction();
          return stagingFailure(
            "Failed to identify the validated staging commit.",
            "Deploy validation passed, but git rev-parse returned an empty commit SHA. The staging worktree is still intact for retry.",
            { toolTelemetry: { stagingDir, branch, prodBranch } },
          );
        }
      }
      dependencyHash ??= dependencySyncHash(stagingDir);
      const validationElapsedMs = validationResult.results.reduce((total, entry) => total + entry.elapsedMs, 0);
      const releaseSlotResult = await prepareReleaseSlot({
        sourceDir: stagingDir,
        dataDir: PRODUCTION_DATA_DIR,
        commitSha: validatedCommitSha,
        source: "staging_deploy",
        validationMode: "deploy",
        run: (command, cwd, options) => run(command, cwd, options),
        log,
        installCommand: STAGING_INSTALL_COMMAND,
        installTimeoutMs: STAGING_INSTALL_TIMEOUT_MS,
      });
      if (!releaseSlotResult.ok) {
        await unstashProduction();
        return commandFailure(
          "Release slot preparation failed.",
          "The rebased staging worktree passed deploy validation, but preparing the inactive release slot failed. The staging worktree is still intact for retry-after-fix.",
          releaseSlotResult.command,
          releaseSlotResult.cwd,
          releaseSlotResult.output,
          { stagingDir, branch, prodBranch },
        );
      }
      const releaseCandidate = releaseSlotResult.manifest;

      // Store pre-deploy SHA so the launcher can roll back to exactly this point
      const headResult = await run("git rev-parse HEAD", PRODUCTION_ROOT);
      const preDeploySha = headResult.ok ? headResult.output.trim() : "";
      let rollbackCheckpoint = { sha: "", createdByCurrentOperation: false };
      if (preDeploySha) {
        const dataDir = join(PRODUCTION_ROOT, "data");
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        rollbackCheckpoint = preserveOrCreateRollbackCheckpoint(PRE_DEPLOY_SHA_FILE, preDeploySha);
        log(
          rollbackCheckpoint.createdByCurrentOperation
            ? `Pre-deploy SHA saved: ${rollbackCheckpoint.sha}`
            : `Using preserved pre-deploy SHA: ${rollbackCheckpoint.sha}`,
        );
      }
      // Merge into production (should be fast-forward after rebase)
      const mergeResult = await run(`git merge "${branch}" --no-edit`, PRODUCTION_ROOT);
      if (!mergeResult.ok) {
        await run("git merge --abort", PRODUCTION_ROOT);
        await unstashProduction();
        removeRollbackCheckpointIfCreated(PRE_DEPLOY_SHA_FILE, rollbackCheckpoint);
        return commandFailure(
          "Merge into production failed after rebase.",
          `Merge failed after rebase (unexpected). The merge has been aborted.\n` +
            `Your staging worktree is still intact. Try running 'git rebase ${prodBranch}' ` +
            `in the staging directory to resolve conflicts, then call staging_deploy again.`,
          `git merge "${branch}" --no-edit`,
          PRODUCTION_ROOT,
          mergeResult.output,
          { stagingDir, branch, prodBranch },
        );
      }

      const newHead = await run("git rev-parse --short HEAD", PRODUCTION_ROOT);
      const commitSha = newHead.ok ? newHead.output.trim() : "unknown";
      log(`Merged to production: ${commitSha}`);

      // Let the launcher own production dependency sync during restart.
      const pkgChanged = await run(`git diff "${preDeploySha}" HEAD --name-only -- ${DEPENDENCY_SYNC_GIT_PATHSPEC}`, PRODUCTION_ROOT);
      if (pkgChanged.ok && pkgChanged.output.trim()) {
        log("Dependency inputs changed — launcher will sync production dependencies during restart");
      }

      // Push to origin so other deployments can pick up the change
      let pushResult = await run(`git push origin ${prodBranch}`, PRODUCTION_ROOT);
      let retryRebaseFailed = false;
      if (!pushResult.ok) {
        // Push may fail if remote has new commits — pull --rebase and retry once
        log("Push failed, attempting pull --rebase before retry...");
        const retryRebase = await run(`git pull --rebase origin ${prodBranch}`, PRODUCTION_ROOT);
        if (retryRebase.ok) {
          pushResult = await run(`git push origin ${prodBranch}`, PRODUCTION_ROOT);
        } else {
          retryRebaseFailed = true;
        }
      }
      if (!pushResult.ok) {
        if (preDeploySha) {
          const resetCommand = `git reset --hard ${preDeploySha}`;
          if (retryRebaseFailed) {
            log("Push retry rebase failed — aborting any in-progress production rebase before reset");
            const abortRebase = await run("git rebase --abort", PRODUCTION_ROOT);
            if (!abortRebase.ok) {
              log(`Warning: git rebase --abort failed before push-failure reset: ${abortRebase.output.slice(-200)}`);
            }
          }
          log(`Push failed — resetting production checkout to pre-deploy SHA ${preDeploySha}`);
          const resetResult = await run(resetCommand, PRODUCTION_ROOT);
          if (!resetResult.ok) {
            return commandFailure(
              "Push to origin failed and production reset failed.",
              `The production merge succeeded locally, but pushing ${prodBranch} to origin failed and resetting the local production checkout back to ${preDeploySha} also failed. ` +
                `Restart signaling was blocked, the rollback checkpoint was preserved, and manual recovery is required before retrying. ` +
                `If production changes were stashed, restore them only after recovering the checkout.`,
              resetCommand,
              PRODUCTION_ROOT,
              joinFailureSections(pushResult.output, resetResult.output) ?? resetResult.output,
              { stagingDir, branch, prodBranch, commitSha, preDeploySha },
            );
          }
          removeRollbackCheckpointIfCreated(PRE_DEPLOY_SHA_FILE, rollbackCheckpoint);
          log(`Production checkout reset to pre-deploy SHA after push failure: ${preDeploySha}`);
        }
        await unstashProduction();
        return commandFailure(
          preDeploySha
            ? "Push to origin failed; production merge reverted and restart blocked."
            : "Push to origin failed; restart blocked.",
          preDeploySha
            ? `The production merge succeeded locally, but pushing ${prodBranch} to origin failed. The local production checkout was reset back to ${preDeploySha}, restart signaling was blocked, and the staging worktree was left intact so deployment can be retried.`
            : `The production merge succeeded locally, but pushing ${prodBranch} to origin failed. Restart signaling was blocked, the rollback checkpoint was preserved, and the staging worktree was left intact for manual recovery.`,
          `git push origin ${prodBranch}`,
          PRODUCTION_ROOT,
          pushResult.output,
          { stagingDir, branch, prodBranch, commitSha, ...(preDeploySha ? { revertedTo: preDeploySha } : {}) },
        );
      }
      log("Pushed to origin");

      const deployedHeadResult = await run("git rev-parse HEAD", PRODUCTION_ROOT);
      const deployedCommitSha = deployedHeadResult.ok ? deployedHeadResult.output.trim() : "";
      if (deployedCommitSha && deployedCommitSha === validatedCommitSha) {
        try {
          // Staging validation covers at least the production deploy gate for this
          // commit; staging-only smoke remains enforced before promotion.
          writeDeployValidationStamp(PRODUCTION_DATA_DIR, {
            commitSha: deployedCommitSha,
            dependencyHash,
            gateId: DEPLOY_GATE.id,
            gateVersion: DEPLOY_GATE_VERSION,
            command: DEPLOY_CHECK_COMMAND,
            source: "staging_deploy",
            validatedAt: new Date().toISOString(),
          });
          log(`Deploy validation stamp written for ${deployedCommitSha}`);
        } catch (error) {
          log(`Deploy validation stamp could not be written; launcher will run the full gate: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        log(
          deployedCommitSha
            ? `Deploy validation stamp skipped because production HEAD changed after validation (${validatedCommitSha} → ${deployedCommitSha})`
            : "Deploy validation stamp skipped because production HEAD could not be read after push",
        );
      }

      await unstashProduction();

      // Signal launcher to restart
      const dataDir = join(PRODUCTION_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      try {
        writeRestartSignalOrRollback(SIGNAL_FILE, "deploy", "staging_deploy", releaseCandidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`Restart signal failed after deploy: ${message}`);
        let cleanupNote = "";
        try {
          await cleanupPreviewArtifactsForStagingDir(stagingDir);
          await removeWorktree(stagingDir, branch);
          deleteStagingValidationStamp(PRODUCTION_DATA_DIR, prefix);
          log("Staging worktree cleaned up after restart signal failure");
        } catch (cleanupErr) {
          cleanupNote = `\n\nPost-deploy cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`;
          log(`Warning: post-deploy cleanup failed after restart signal failure: ${cleanupErr}`);
        }
        return stagingFailure(
          "Deployment pushed but restart signal failed.",
          `Deployment ${commitSha} was pushed to ${prodBranch}, but the launcher restart signal could not be written. Manual restart is required.\n\n${message}${cleanupNote}`,
          {
            sessionLog: `Deployment ${commitSha} was pushed, but writing ${SIGNAL_FILE} failed: ${message}${cleanupNote}`,
            toolTelemetry: { stagingDir, branch, prodBranch, commitSha, signalFile: SIGNAL_FILE },
          },
        );
      }
      log("Restart signal sent");

      // Cleanup staging worktree and branch (best-effort — deploy already succeeded)
      try {
        await cleanupPreviewArtifactsForStagingDir(stagingDir);
        await removeWorktree(stagingDir, branch);
        deleteStagingValidationStamp(PRODUCTION_DATA_DIR, prefix);
        log("Staging worktree cleaned up");
      } catch (err) {
        log(`Warning: post-deploy cleanup failed (non-fatal): ${err}`);
      }

      const deployElapsedMs = Date.now() - deployStartedAt;
      log(`Deploy completed in ${formatCommandDuration(deployElapsedMs)}`);
      return {
        success: true,
        commitSha,
        elapsedMs: deployElapsedMs,
        validationElapsedMs,
        message: `Deployed ${commitSha} to production in ${formatCommandDuration(deployElapsedMs)}. Restart signal sent — do NOT make any more tool calls.`,
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

      await cleanupPreviewArtifactsForStagingDir(stagingDir);
      await removeWorktree(stagingDir, branch);
      deleteStagingValidationStamp(PRODUCTION_DATA_DIR, prefix);

      log("Staging worktree cleaned up");
      return { success: true, message: `Staging worktree removed: ${stagingDir}` };
    },
  }),
]);
