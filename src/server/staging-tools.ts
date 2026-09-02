// Per-session staging worktrees for validated code deployment
// Each session gets an isolated worktree to make changes, run quality checks,
// and deploy only after validation passes.

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type express from "express";
import { randomBytes } from "node:crypto";
import {
  dependencySyncHash,
  DEPENDENCY_SYNC_GIT_PATHSPEC,
  preparePatchedPackagesForInstall,
  readInstalledDependencyHash,
} from "./dependency-sync.js";
import { preserveOrCreateRollbackCheckpoint, removeRollbackCheckpointIfCreated } from "./pre-deploy-checkpoint.js";
import { isRestartAlreadyInFlight } from "./restart-state.js";
import { lifecycleBusyToolFailure, writeRestartSignalOrRollback } from "./restart-inflight.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type DefineBridgeToolOptions,
} from "./agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";
import {
  createDirectoryLink,
  removeDirectoryLink,
} from "./platform.js";
import { buildPublicUrl } from "./public-url.js";
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
  abortStagingPreviewRebuild,
  beginStagingPreviewRebuild,
  buildStagingBackendSpawnConfig,
  cleanupStagingBackendResources,
  createStagingProxyHandler,
  finishStagingPreviewRebuild,
  forgetStagingPreviewBackend,
  getExistingPreviewRuntime,
  getStagingPreviewRebuildJobId,
  hasSeededStagingDatabase,
  hasActiveStagingBackend,
  getStagingRouter,
  hasPendingStagingBackendStart,
  hasRegisteredExpressApp,
  hasStagingBackendState,
  initializeStagingBackend,
  registerExpressApp,
  hasRestorablePreviewTarget,
  isPreviewRetiredAfterStartFailures,
  rememberRestorablePreviewTarget,
  restoreStagingBackendWithRetry,
  scheduleStartupBackendWarmup,
  seedStagingData,
  startStagingBackendProcess,
  __testing as backendManagerTesting,
  type RestoreStagingBackendWithRetryOptions,
  type SeedStagingDataOptions,
} from "./staging-backend-manager.js";
import {
  clearPreviewRebuildReady,
  createPreviewRebuildCoordination,
  signalPreviewRebuildFailure,
  signalPreviewRebuildReady,
  waitForPreviewRebuildReady,
  type PreviewRebuildCoordination,
} from "./staging-preview-rebuild-coordination.js";
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
  buildPreviewPrefix,
  createPreviewTarget,
  directoryMtimeMs,
  listStagingPreviewParents,
  parsePreviewPrefix,
  previewTargetLastActivityMs,
  removeDirectoryWithRetries,
  removePreviewData,
  shouldManageStagingArtifacts,
  uniqueResolvedPaths,
  type PreviewTarget,
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
import { bridgeToolResult, toolFailure } from "./tool-results.js";
import {
  extractCommandFailureLogPath,
  extractCommandFailureLogWriteError,
  formatCommandDuration,
} from "./validation-command-log.js";
import { createValidationCommandEnv, prependNodePath } from "./validation-command-env.js";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";
import { runValidationCommand } from "./validation-command-runner.js";
import type { AppContext } from "./app-context.js";
import {
  ActiveManagementJobError,
  type ManagementJob,
  type ManagementJobStore,
} from "./management-job-store.js";
import {
  createStagingPreviewDiscovery,
  type StagingPreviewDiscoveryController,
  type StagingPreviewDiscoveryTrigger,
} from "./staging-preview-discovery.js";
import { queuedManagementJobResult } from "./management-job-tool-results.js";
import { createGitPullRebaseCommand } from "./git-command.js";


type StagingRunOptions = {
  timeoutMs?: number;
  isolateRuntimeEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  executable?: string;
  args?: readonly string[];
};
type StagingCommandRunner = (
  cmd: string,
  cwd: string,
  options?: StagingRunOptions,
) => Promise<{ ok: boolean; output: string }>;

async function cleanupPreviewArtifactsForStagingDir(stagingDir: string): Promise<void> {
  await cleanupPreviewTarget(stagingDir);
}

export async function cleanupCompletedStagingDeploy(stagingDir: string): Promise<void> {
  const prefix = basename(stagingDir);
  await cleanupPreviewArtifactsForStagingDir(stagingDir);
  await removeWorktree(stagingDir, `staging/${prefix}`);
  deleteStagingValidationStamp(PRODUCTION_DATA_DIR, prefix);
}

async function cleanupPreviewResources(
  prefix: string,
  options: { removeDist?: boolean; removeData?: boolean } = {},
): Promise<void> {
  const removeDist = options.removeDist ?? true;
  const ownedByThisProcess = activePreviews.has(prefix) || hasStagingBackendState(prefix);

  if (ownedByThisProcess) {
    await cleanupStagingBackendResources(prefix, { removeData: options.removeData });
  }
  if (removeDist) {
    removeStagingDist(prefix);
  }
}

export async function cleanupPreviewTarget(
  stagingDir: string,
  options: { removeData?: boolean } = {},
): Promise<void> {
  const target = createPreviewTarget(stagingDir);
  await cleanupPreviewResources(target.prefix, options);
}

/**
 * Compare dependency inputs between staging and production.
 * If package files or patch-package files differ, replace the node_modules
 * symlink with a real npm install so builds use the correct dependency state.
 * The link is also unsafe when the production root itself has not been
 * re-installed for its current inputs (the launcher activates prepared release
 * slots without rebuilding the root), so the launcher's recorded install hash
 * wins over the production source hash when it is available.
 */
/** Exported for focused tests of the fresh-install guard. */
export async function ensureStagingDeps(
  stagingDir: string,
  options: { runCommand?: StagingCommandRunner; log?: (message: string) => void } = {},
): Promise<{ ok: boolean; command?: string; output?: string }> {
  const writeLog = options.log ?? log;
  const runCommand = options.runCommand ?? run;
  const stagingHash = dependencySyncHash(stagingDir);
  const productionHash = dependencySyncHash(PRODUCTION_ROOT);
  const installedHash = readInstalledDependencyHash(PRODUCTION_DATA_DIR);
  if (stagingHash === productionHash) {
    if (installedHash === undefined || installedHash === productionHash) {
      return { ok: true };
    }
    writeLog("Production node_modules lag the production dependency inputs — installing dependencies in staging...");
  } else {
    writeLog("Staging dependency inputs differ from production — installing dependencies in staging...");
  }

  // If node_modules is a symlink/junction, remove it so npm can create a real directory.
  // If it's already a real directory, leave it — npm install is incremental.
  const stagingModules = join(stagingDir, "node_modules");
  if (existsSync(stagingModules)) {
    try {
      const stat = lstatSync(stagingModules);
      if (stat.isSymbolicLink()) {
        const removal = removeDirectoryLink(stagingModules, PRODUCTION_ROOT);
        if (!removal.ok) {
          // The link still points at production's node_modules. Installing over
          // it would resolve into the live install and can corrupt it.
          const output = `Unable to remove staging node_modules symlink at ${stagingModules}: ${removal.output}`;
          writeLog(output);
          return { ok: false, command: "remove staging node_modules symlink", output };
        }
        writeLog("Removed node_modules symlink for fresh install");
      } else {
        writeLog("node_modules is a real directory — running incremental install");
      }
    } catch {
      // lstat failed — try to proceed anyway
    }
  }

  const prepared = preparePatchedPackagesForInstall(stagingDir);
  if (prepared.packages.length > 0) {
    writeLog(`Prepared patched packages for staging install: ${prepared.packages.join(", ")}`);
  }

  const installResult = await runCommand(STAGING_INSTALL_COMMAND, stagingDir, {
    timeoutMs: STAGING_INSTALL_TIMEOUT_MS,
  });
  if (installResult.ok) {
    prepared.discard();
    writeLog("Staging npm install succeeded");
    return { ok: true };
  }
  prepared.restore();
  writeLog(`Staging npm install failed: ${installResult.output.slice(-300)}`);
  return { ok: false, command: STAGING_INSTALL_COMMAND, output: installResult.output };
}

/** Active staging previews: prefix -> dist path */
const activePreviews = new Map<string, string>();

/** Returns the map of active staging previews for the Express middleware to use. */
export function getActivePreviews(): ReadonlyMap<string, string> {
  return activePreviews;
}

/**
 * True when a preview is still registered in this process but its built assets are
 * gone (deployed, cleaned up, or mid-rebuild). Callers use this to refuse routing —
 * including lazy staged-backend starts — and to trigger a reconciling rescan.
 */
export function isRegisteredStagingPreviewMissing(prefix: string): boolean {
  const distDir = activePreviews.get(prefix);
  return distDir !== undefined && !existsSync(join(distDir, "index.html"));
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
  outDir: string,
): PreviewTarget {
  return {
    ...createPreviewTarget(join(stagingParent, prefix)),
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

        const isNewFrontend = !previewMap.has(entry.name);
        const target = createRestorablePreviewTarget(
          stagingParent,
          parsed,
          distDir,
        );

        if (isNewFrontend) {
          previewMap.set(entry.name, distDir);
          registeredPreviewDirs++;
        }

        // Backend registration is tracked separately from the frontend entry:
        // a preview retired after repeated backend start failures keeps serving
        // its built assets, and its backend is only re-registered once the dist
        // directory is rebuilt (newer mtime than the retirement).
        if (
          shouldRegisterBackends
          && !hasRestorablePreviewTarget(entry.name)
          && !isPreviewRetiredAfterStartFailures(entry.name, target.updatedAtMs)
        ) {
          rememberRestorablePreviewTarget(target);
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

/**
 * Reconcile in-process preview state with what is on disk.
 *
 * Preview builds happen in the management-job-runner process, so this runs when a
 * watched management job reaches a terminal state (or when a request finds a
 * registered preview whose assets are gone) instead of on a permanent interval.
 */
async function runStagingPreviewDiscovery(
  trigger: StagingPreviewDiscoveryTrigger,
  writeLog: (msg: string) => void,
): Promise<void> {
  for (const job of trigger.completedJobs) {
    if (job.type !== "staging_preview") continue;
    const target = getPreviewJobTarget(job.input);
    const coordination = createPreviewRebuildCoordination(job);
    clearPreviewRebuildReady(coordination);
    if (!target) continue;

    const rebuildJobId = getStagingPreviewRebuildJobId(target.prefix);
    if (rebuildJobId === job.id) {
      const released = finishStagingPreviewRebuild(target.prefix, job.id, {
        rebuilt: job.status === "succeeded",
      });
      if (released) {
        writeLog(
          job.status === "succeeded"
            ? `Staging preview ${target.prefix} rebuild completed; lazy backend startup is enabled`
            : `Staging preview ${target.prefix} rebuild ended with ${job.status}; the previous backend may start lazily again`,
        );
      } else {
        writeLog(`Warning: staging preview ${target.prefix} remains suppressed because its previous backend did not stop cleanly`);
      }
    } else if (job.status === "succeeded") {
      await invalidateRebuiltPreviewBackend(job.input, writeLog);
    }
  }
  await cleanupMissingRegisteredPreviews(writeLog);
  registerExistingPreviewsFromDisk({ log: writeLog });
}

function getPreviewJobTarget(input: unknown): PreviewTarget | null {
  const stagingDir = typeof input === "object" && input !== null
    ? (input as { stagingDir?: unknown }).stagingDir
    : undefined;
  if (typeof stagingDir !== "string" || stagingDir.trim() === "") return null;
  const target = createPreviewTarget(stagingDir);
  return parsePreviewPrefix(target.prefix) ? target : null;
}

async function prepareStagingPreviewRebuilds(
  jobs: ManagementJob[],
  writeLog: (msg: string) => void,
): Promise<void> {
  for (const job of jobs) {
    if (job.type !== "staging_preview") continue;
    const target = getPreviewJobTarget(job.input);
    const coordination = createPreviewRebuildCoordination(job);
    if (!target || !coordination) {
      writeLog(`Warning: management job ${job.id} could not establish staging preview rebuild coordination`);
      continue;
    }

    try {
      await beginStagingPreviewRebuild(target.prefix, job.id);
      signalPreviewRebuildReady(coordination, target.prefix);
      writeLog(`Staging preview ${target.prefix} backend stopped and suppressed for rebuild`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      abortStagingPreviewRebuild(target.prefix, job.id);
      try {
        signalPreviewRebuildFailure(coordination, target.prefix, message);
      } catch (signalError) {
        writeLog(
          `Warning: could not report staging preview ${target.prefix} rebuild preparation failure: `
          + `${signalError instanceof Error ? signalError.message : String(signalError)}`,
        );
      }
      writeLog(
        `Warning: could not prepare staging preview ${target.prefix} for rebuild: `
        + message,
      );
    }
  }
}

/**
 * A rebuilt preview must not keep serving its previous staged backend: the runner
 * only replaces the frontend bundle, so the in-process child process still runs the
 * pre-rebuild code. Dropping the backend state here lets the next API request lazily
 * restore it from the new build (its seeded data dir is preserved).
 */
async function invalidateRebuiltPreviewBackend(
  input: unknown,
  writeLog: (msg: string) => void,
): Promise<void> {
  const stagingDir = typeof input === "object" && input !== null
    ? (input as { stagingDir?: unknown }).stagingDir
    : undefined;
  if (typeof stagingDir !== "string" || stagingDir.trim() === "") return;

  const prefix = buildPreviewPrefix(stagingDir);
  if (!parsePreviewPrefix(prefix)) return;
  if (!hasStagingBackendState(prefix)) return;

  try {
    await cleanupStagingBackendResources(prefix, { removeData: false });
    writeLog(`Staging preview ${prefix} was rebuilt — staged backend will restart on the new build`);
  } catch (error) {
    writeLog(`Warning: could not reset staged backend for rebuilt preview ${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Start event-driven preview discovery for management jobs run by the separate
 * runner process. Returns null when there is no job store or when staging artifacts
 * are not managed (packaged release mode).
 */
export function startStagingPreviewDiscovery(options: {
  store?: ManagementJobStore | null;
  log?: (msg: string) => void;
  pollIntervalMs?: number;
} = {}): StagingPreviewDiscoveryController | null {
  const { store } = options;
  if (!store) return null;
  if (!shouldManageStagingArtifacts()) return null;

  const writeLog = options.log ?? log;
  const controller = createStagingPreviewDiscovery({
    store,
    log: writeLog,
    pollIntervalMs: options.pollIntervalMs,
    prepare: (jobs) => prepareStagingPreviewRebuilds(jobs, writeLog),
    discover: (trigger) => runStagingPreviewDiscovery(trigger, writeLog),
  });
  controller.resumeActiveJobs();
  return controller;
}

async function cleanupMissingRegisteredPreviews(writeLog: (msg: string) => void): Promise<void> {
  for (const [prefix, distDir] of [...activePreviews.entries()]) {
    if (existsSync(join(distDir, "index.html"))) continue;
    if (getStagingPreviewRebuildJobId(prefix)) {
      writeLog(`Staging preview ${prefix} assets are temporarily unavailable during rebuild`);
      activePreviews.delete(prefix);
      continue;
    }
    writeLog(`Staging preview ${prefix} disappeared from disk — cleaning up in-process backend state`);
    activePreviews.delete(prefix);
    try {
      await cleanupStagingBackendResources(prefix);
    } catch (error) {
      writeLog(`Warning: cleanup for disappeared staging preview ${prefix} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
  options: StagingRunOptions = {},
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
  options.log?.(`$ ${cmd}\n[cwd] ${cwd}`);
  try {
    const result = await runValidationCommand({
      rootDir: PRODUCTION_ROOT,
      source: "staging",
      command: options.executable ?? cmd,
      args: options.args,
      displayCommand: cmd,
      cwd,
      env,
      timeoutMs,
      shell: options.args ? false : undefined,
      failureOutputFormat: "plain",
    });
    if (result.output.trim()) options.log?.(result.output.trimEnd());
    return result;
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

/**
 * Restart-pending failure with a protocol-level Bridge tool contract.
 *
 * Thin wrapper over the shared lifecycle-busy envelope so the staging tools
 * keep their stagingDir/signalFile telemetry.
 */
function stagingRestartPendingFailure(
  stagingDir: string,
  verb: "deploying" | "previewing",
) {
  return lifecycleBusyToolFailure({
    busy: { reason: "restart_in_flight" },
    retryTarget: verb === "deploying" ? "the deploy" : "the preview",
    toolTelemetry: { stagingDir, signalFile: SIGNAL_FILE },
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
    byStagingName.set(parsed, [...(byStagingName.get(parsed) ?? []), target]);
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
              parsed,
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
  getExistingPreviewRuntime,
  startStagingBackendProcess,
  createStagingProxyHandler,
  buildStagingBackendSpawnConfig,
  restoreStagingBackendWithRetry,
  writeRestartSignalOrRollback,
  listStagingBranchPrefixes,
  pruneOrphanedWorktreesImpl,
  getStagingPreviewParent: () => STAGING_PREVIEW_PARENT,
  listStagingPreviewParents,
  cleanupMissingRegisteredPreviews,
  cleanupStagingBackendResources,
  seedActivePreview(prefix: string, distDir: string): void {
    activePreviews.set(prefix, distDir);
  },
  hasActivePreview(prefix: string): boolean {
    return activePreviews.has(prefix);
  },
  resetActivePreviews(): void {
    activePreviews.clear();
  },
  backendManager: backendManagerTesting,
};

export interface StagingPreviewJobInput {
  stagingDir: string;
  validate?: boolean;
}

export interface StagingJobRunOptions {
  log?: (message: string) => void;
  startBackend?: boolean;
  registerInProcess?: boolean;
  seedPreviewData?: (stagingDir: string) => void;
  rebuildCoordination?: PreviewRebuildCoordination;
  deferDeployRestart?: boolean;
}

export async function runStagingPreviewJob(
  args: StagingPreviewJobInput,
  options: StagingJobRunOptions = {},
): Promise<Record<string, unknown>> {
  const { stagingDir } = args;
  const shouldValidate = args.validate !== false;
  const writeLog = options.log ?? log;
  const runCommand: StagingCommandRunner = (cmd, cwd, runOptions = {}) =>
    run(cmd, cwd, { ...runOptions, log: writeLog });

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

  const target = createPreviewTarget(stagingDir);
  const { prefix, basePath, outDir } = target;

  writeLog(`Building staging preview: ${stagingDir} → ${outDir} (base: ${basePath})`);

  if (
    options.startBackend !== true
    && options.rebuildCoordination
    && hasSeededStagingDatabase(stagingDir)
  ) {
    writeLog(`Waiting for the live server to stop the existing staged backend for ${prefix}...`);
    try {
      await waitForPreviewRebuildReady(options.rebuildCoordination);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return stagingFailure(
        "Staging preview rebuild coordination failed.",
        message,
        {
          sessionLog: `Staging preview rebuild coordination failed for ${stagingDir}: ${message}`,
          toolTelemetry: { stagingDir, previewPath: basePath, outDir },
        },
      );
    }
    writeLog(`Existing staged backend for ${prefix} is stopped; rebuild may proceed.`);
  }

  const previewParent = dirname(outDir);
  if (!existsSync(previewParent)) {
    mkdirSync(previewParent, { recursive: true });
  }

  const depsResult = await ensureStagingDeps(stagingDir, { runCommand, log: writeLog });
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
    const preValidationHead = await runCommand("git rev-parse HEAD", stagingDir);
    const preValidationCommitSha = preValidationHead.ok ? preValidationHead.output.trim() : "";
    const preValidationDependencyHash = dependencySyncHash(stagingDir);
    const validationResult = await runValidationGateAsync(PREVIEW_GATE, {
      cwd: stagingDir,
      run: (command, validationOptions) => runCommand(command, stagingDir, validationOptions),
      log: writeLog,
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
    const postValidationHead = await runCommand("git rev-parse HEAD", stagingDir);
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
        writeLog(`Staging preview validation stamp written for ${prefix} at ${postValidationCommitSha}`);
      } catch (error) {
        writeLog(`Staging preview validation stamp could not be written; deploy will run the full gate: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      const reason = !preValidationCommitSha
        ? `staging HEAD could not be read before validation: ${preValidationHead.ok ? "empty git rev-parse output" : preValidationHead.output.slice(-200)}`
        : !postValidationCommitSha
          ? `staging HEAD could not be read after validation: ${postValidationHead.ok ? "empty git rev-parse output" : postValidationHead.output.slice(-200)}`
          : preValidationCommitSha !== postValidationCommitSha
            ? `staging HEAD changed during validation (${preValidationCommitSha} -> ${postValidationCommitSha})`
            : "dependency inputs changed during validation";
      writeLog(`Staging preview validation stamp skipped because ${reason}`);
    }
  } else {
    writeLog("Skipping staging preview validation");
  }

  const buildResult = await runCommand(
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

  if (options.startBackend !== true) {
    writeLog("Preparing isolated staging data snapshot...");
    try {
      const seedPreviewData = options.seedPreviewData ?? seedStagingData;
      seedPreviewData(stagingDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return stagingFailure(
        "Staging preview data preparation failed.",
        `The isolated staging runtime could not be prepared: ${message}`,
        {
          sessionLog: `Staging preview data preparation failed for ${stagingDir}: ${message}`,
          toolTelemetry: { stagingDir, previewPath: basePath, outDir },
        },
      );
    }
    writeLog("Isolated staging data snapshot ready.");
  }

  const registerInProcess = options.registerInProcess ?? options.startBackend === true;
  if (registerInProcess) {
    activePreviews.set(prefix, outDir);
    rememberRestorablePreviewTarget(target);
  }

  let backendReady = false;
  let backendError: string | undefined;

  if (options.startBackend === true) {
    if (hasRegisteredExpressApp()) {
      try {
        await initializeStagingBackend(prefix, stagingDir);
        backendReady = true;
      } catch (err) {
        backendError = err instanceof Error ? err.message : String(err);
        await cleanupPreviewResources(prefix, { removeDist: false });
        writeLog(`Staging backend failed (frontend-only preview): ${backendError}`);
      }
    } else {
      writeLog("Express app not registered — frontend-only preview");
    }
  } else {
    writeLog("Preview build and data preparation complete; live server will discover the frontend and restore the backend lazily.");
  }

  const fullUrl = buildPublicUrl(basePath) ?? null;
  const localUrl = `http://localhost:${config.web.port}${basePath}`;
  const backendNote = backendReady
    ? " Backend API is live at the same path (/api routes)."
    : backendError
      ? ` Backend failed to start: ${backendError}. Frontend-only preview.`
      : options.startBackend === true
        ? " Frontend-only preview (no Express app registered)."
        : " Backend API will start lazily in the live server after preview discovery.";

  writeLog(`Staging preview ready at ${fullUrl || localUrl}`);
  return {
    success: true,
    previewPath: basePath,
    previewUrl: fullUrl,
    localUrl,
    backendReady,
    backendError,
    message: (fullUrl
      ? `Staging preview is live at ${fullUrl} (also available locally at ${localUrl}) — share this link with the user and wait for confirmation before deploying.`
      : `Staging preview is live locally at ${localUrl} — share this link with the user and wait for confirmation before deploying.`) + backendNote,
  };
}

export interface StagingDeployJobInput {
  stagingDir: string;
  message: string;
}

/**
 * Tracks the production `git stash` created for a deploy so a failed or
 * ambiguous `git stash pop` can never be reported as a clean success.
 *
 * The entry is created with a unique marker message and located by that marker,
 * so a stash someone else pushed during the deploy window is never mistaken for
 * this deploy's entry. `restore` is installed by the deploy body so the wrapper
 * can finalize a still-pending stash even when the body throws, and `suppressed`
 * marks the recovery paths that deliberately leave the stash in place.
 */
interface ProductionStashState {
  pending: boolean;
  suppressed: boolean;
  restored?: boolean;
  sha?: string;
  warning?: string;
  restore?: () => Promise<void>;
}

interface ProductionStashEntry {
  sha: string;
  subject: string;
}

const PRODUCTION_STASH_LIST_COMMAND = 'git --no-pager stash list --format="%H %gs"';

const STASH_RESTORE_WARNING_SUMMARY =
  "Warning: your uncommitted production changes could not be restored automatically and are still saved in git stash.";

function stashRestoreWarning(reason: string, details?: string): string {
  return joinFailureSections(
    `${STASH_RESTORE_WARNING_SUMMARY} ${reason} ` +
      `Recover them manually: run 'git status' and 'git stash list' in ${PRODUCTION_ROOT}, resolve any conflicts left in the working tree, ` +
      "and reapply the entry with 'git stash pop' (or 'git stash apply <entry>') only if 'git stash list' still shows it.",
    truncateFailureText(details, FAILURE_DETAIL_OUTPUT_LIMIT),
  ) ?? STASH_RESTORE_WARNING_SUMMARY;
}

/** Stash entries newest first, i.e. entry 0 is what `git stash pop` would apply. */
async function readProductionStashEntries(
  runCommand: StagingCommandRunner,
): Promise<{ ok: boolean; entries: ProductionStashEntry[]; output: string }> {
  const result = await runCommand(PRODUCTION_STASH_LIST_COMMAND, PRODUCTION_ROOT);
  const entries = result.ok
    ? result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(" ");
        return separator === -1
          ? { sha: line, subject: "" }
          : { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
      })
    : [];
  return { ok: result.ok, entries, output: result.output };
}

function appendWarningText(value: string, warning: string): string {
  return joinFailureSections(value, warning) ?? warning;
}

function appendWarningField(target: Record<string, unknown>, field: string, warning: string): void {
  const value = target[field];
  if (typeof value === "string") target[field] = appendWarningText(value, warning);
}

/**
 * Makes a failed stash restore visible on every deploy outcome — including the
 * success path — without depending on each return site remembering to mention it.
 */
function appendStashRecoveryWarning(
  result: Record<string, unknown>,
  warning: string,
): Record<string, unknown> {
  const patched: Record<string, unknown> = {
    ...result,
    stashRestoreFailed: true,
    stashRecoveryWarning: warning,
  };
  for (const field of ["textResultForLlm", "sessionLog", "message"]) {
    appendWarningField(patched, field, warning);
  }
  appendWarningField(patched, "summary", STASH_RESTORE_WARNING_SUMMARY);
  if (Array.isArray(patched.content)) {
    patched.content = patched.content.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? { ...entry, text: appendWarningText(text, warning) } : entry;
    });
  }
  return patched;
}

/** Restore is best-effort: it must never turn a completed deploy into a thrown error. */
async function finalizeProductionStash(
  stash: ProductionStashState,
  writeLog?: (message: string) => void,
): Promise<void> {
  try {
    await stash.restore?.();
  } catch (error) {
    stash.pending = false;
    const details = error instanceof Error ? error.message : String(error);
    if (!stash.restored) {
      stash.warning ??= stashRestoreWarning("Restoring it after the deploy threw an unexpected error.", details);
    }
    try {
      writeLog?.(`Stash restore raised an unexpected error: ${details}`);
    } catch {
      // Logging must never change the deploy outcome.
    }
  }
}

export async function runStagingDeployJob(
  args: StagingDeployJobInput,
  options: StagingJobRunOptions = {},
): Promise<Record<string, unknown>> {
  const stash: ProductionStashState = { pending: false, suppressed: false };
  try {
    const result = await runStagingDeployJobImpl(args, options, stash);
    await finalizeProductionStash(stash);
    return stash.warning ? appendStashRecoveryWarning(result, stash.warning) : result;
  } catch (error) {
    await finalizeProductionStash(stash);
    // The original error is what callers classify on, so only enrich its text.
    if (stash.warning && error instanceof Error) {
      error.message = appendWarningText(error.message, stash.warning);
      if (typeof error.stack === "string") {
        error.stack = appendWarningText(error.stack, stash.warning);
      }
    }
    throw error;
  }
}

async function runStagingDeployJobImpl(
  args: StagingDeployJobInput,
  options: StagingJobRunOptions,
  stash: ProductionStashState,
): Promise<Record<string, unknown>> {
  const { stagingDir, message } = args;
  const deployStartedAt = Date.now();
  const writeLog = options.log ?? log;
  const runCommand: StagingCommandRunner = (cmd, cwd, runOptions = {}) =>
    run(cmd, cwd, { ...runOptions, log: writeLog });

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

  if (isRestartAlreadyInFlight(PRODUCTION_DATA_DIR)) {
    return stagingRestartPendingFailure(stagingDir, "deploying");
  }

  const prefix = basename(stagingDir);
  const branch = `staging/${prefix}`;

  writeLog(`Deploying from ${stagingDir} (branch: ${branch})`);
  ensureNodeModulesIgnored(stagingDir);

  const addResult = await runCommand("git add -A", stagingDir);
  if (!addResult.ok) {
    return commandFailure(
      "Failed to stage staging worktree changes for the deploy commit.",
      "Staging the worktree changes with git add failed, so the deploy commit would have captured only a partial change set. " +
        "No commit, merge, or push was attempted; the staging worktree and index were left in place so staging_deploy can be retried after fixing the git issue.",
      "git add -A",
      stagingDir,
      addResult.output,
      { stagingDir, branch },
    );
  }
  const status = await runCommand("git --no-pager status --porcelain", stagingDir);
  if (!status.ok) {
    return commandFailure(
      "Failed to read the staging worktree status.",
      "Reading the staging worktree status failed, so the deploy could not tell whether there were uncommitted changes to commit. " +
        "Deploying an unknown working-tree state was blocked; no commit, merge, or push was attempted and the staging worktree and index were left in place for retry.",
      "git --no-pager status --porcelain",
      stagingDir,
      status.output,
      { stagingDir, branch },
    );
  }
  const hasUncommittedChanges = !!status.output.trim();

  if (hasUncommittedChanges) {
    const msgFile = join(stagingDir, ".commit-msg");
    try {
      writeFileSync(msgFile, `${String(message ?? "").replace(/\s+$/, "")}\n`);
      const commitResult = await runCommand(`git commit -F "${msgFile}"`, stagingDir);
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
      try {
        unlinkSync(msgFile);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  const prodBranchResult = await runCommand("git rev-parse --abbrev-ref HEAD", PRODUCTION_ROOT);
  const prodBranch = prodBranchResult.ok ? prodBranchResult.output.trim() : "main";

  const aheadCheck = await runCommand(`git log ${prodBranch}..${branch} --oneline`, PRODUCTION_ROOT);
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

  const stashMarker = `bridge-deploy-${prefix}-${randomBytes(4).toString("hex")}`;
  const stashCommand = `git stash push --include-untracked -m "${stashMarker}"`;
  const safeWriteLog = (message: string) => {
    try {
      writeLog(message);
    } catch {
      // Logging must never change the deploy outcome.
    }
  };
  // Recovery commands log through the guarded sink so a broken logger cannot
  // make a successful restore look like a stranded stash.
  const runRecoveryCommand: StagingCommandRunner = (cmd, cwd, runOptions = {}) =>
    run(cmd, cwd, { ...runOptions, log: safeWriteLog });

  const popProductionStash = async () => {
    if (!stash.pending || stash.suppressed) return;
    // Clear first so an unexpected failure can never trigger a second pop.
    stash.pending = false;
    const currentEntries = await readProductionStashEntries(runRecoveryCommand);
    const [top] = currentEntries.entries;
    if (!currentEntries.ok || top?.sha !== stash.sha) {
      stash.warning = stashRestoreWarning(
        `The stash entry created for this deploy (${stash.sha}, message '${stashMarker}') is no longer the entry 'git stash pop' would apply, so it was left untouched.`,
        currentEntries.ok ? `Current top stash entry: ${top ? `${top.sha} ${top.subject}` : "(none)"}` : currentEntries.output,
      );
      safeWriteLog(`Stashed production changes left in place: deploy stash ${stash.sha} is no longer the top stash entry`);
      return;
    }
    const popResult = await runRecoveryCommand("git stash pop", PRODUCTION_ROOT);
    if (popResult.ok) {
      stash.restored = true;
      safeWriteLog("Restored stashed production changes");
      return;
    }
    stash.warning = stashRestoreWarning(`'git stash pop' failed in ${PRODUCTION_ROOT}.`, popResult.output);
    safeWriteLog(`Failed to restore stashed production changes: ${popResult.output.slice(-200)}`);
  };
  stash.restore = popProductionStash;
  // Deploy paths always use the non-throwing form so a broken restore cannot
  // replace the outcome they were about to report.
  const unstashProduction = () => finalizeProductionStash(stash, writeLog);

  // Assume the worst until the stash outcome is confirmed, so an exception
  // between here and identification still tells the user where to look.
  stash.warning = stashRestoreWarning(
    `The deploy could not confirm the outcome of '${stashCommand}' in ${PRODUCTION_ROOT}, so uncommitted production changes may be stashed under the message '${stashMarker}'.`,
  );
  const stashResult = await runCommand(stashCommand, PRODUCTION_ROOT);
  if (!stashResult.ok) {
    stash.warning = undefined;
    return commandFailure(
      "Failed to stash uncommitted production changes.",
      "Stashing the production checkout failed, so the deploy stopped before pulling, rebasing, merging, or pushing anything. " +
        `Check 'git status' and 'git stash list' in ${PRODUCTION_ROOT} for an entry named '${stashMarker}' before retrying; the staging worktree is intact.`,
      stashCommand,
      PRODUCTION_ROOT,
      stashResult.output,
      { stagingDir, branch, prodBranch },
    );
  }
  const stashEntries = await readProductionStashEntries(runCommand);
  if (!stashEntries.ok) {
    stash.warning = stashRestoreWarning(
      `The production stash list could not be read after stashing, so any entry this deploy created (message '${stashMarker}') was left untouched.`,
      stashEntries.output,
    );
    writeLog(`Could not identify the production stash created for this deploy ('${stashMarker}') — leaving it in place`);
  } else {
    stash.warning = undefined;
    const created = stashEntries.entries.find((entry) => entry.subject.includes(stashMarker));
    if (created) {
      stash.sha = created.sha;
      stash.pending = true;
      writeLog(`Stashed uncommitted production changes (${created.sha})`);
    }
  }

  const pullCommand = createGitPullRebaseCommand(prodBranch);
  const pullResult = await runCommand(pullCommand.displayCommand, PRODUCTION_ROOT, {
    executable: pullCommand.command,
    args: pullCommand.args,
  });
  if (pullResult.ok) {
    writeLog("Pulled latest production from origin");
  } else {
    writeLog(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
  }

  const rebaseResult = await runCommand(`git rebase ${prodBranch}`, stagingDir);
  if (!rebaseResult.ok) {
    await runCommand("git rebase --abort", stagingDir);
    await unstashProduction();
    writeLog("Staging rebase failed — manual conflict resolution needed");
    return commandFailure(
      "Staging branch conflicts with production.",
      `Staging branch has conflicts with the latest production code. ` +
        `The rebase has been aborted and your staging worktree is intact.\n\n` +
        `To resolve (all commands run in the staging directory ${stagingDir}):\n` +
        `1. git rebase ${prodBranch}\n` +
        "2. Resolve conflicting files shown by git\n" +
        "3. git add <resolved-files>\n" +
        "4. git rebase --continue\n" +
        "5. Repeat steps 2-4 if there are more conflicts\n" +
        "6. Call staging_deploy again — it will skip the commit and proceed to merge",
      `git rebase ${prodBranch}`,
      stagingDir,
      rebaseResult.output,
      { stagingDir, branch, prodBranch },
    );
  }
  writeLog("Staging branch rebased onto production");

  const depsResult = await ensureStagingDeps(stagingDir, { runCommand, log: writeLog });
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
    const candidateHeadResult = await runCommand("git rev-parse HEAD", stagingDir);
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
      writeLog(`Preview validation stamp not used: staging HEAD could not be read (${candidateHeadResult.ok ? "empty git rev-parse output" : candidateHeadResult.output.slice(-200)})`);
    }
  }
  const deployGate = stagingValidation.valid ? DEPLOY_SMOKE_GATE : STAGING_DEPLOY_GATE;
  if (stagingValidation.valid) {
    writeLog(`Preview validation stamp matched for ${prefix} at ${validatedCommitSha} — running smoke-only deploy validation`);
  } else {
    writeLog(`Preview validation stamp not used: ${stagingValidation.reason}`);
  }

  const validationResult = await runValidationGateAsync(deployGate, {
    cwd: stagingDir,
    run: (command, validationOptions) => runCommand(command, stagingDir, { ...validationOptions, env: deployValidationEnv() }),
    log: writeLog,
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
    const validatedHeadResult = await runCommand("git rev-parse HEAD", stagingDir);
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
    run: (command, cwd, runOptions) => runCommand(command, cwd, runOptions),
    log: writeLog,
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
  if (releaseCandidate.commitSha !== validatedCommitSha) {
    await unstashProduction();
    return stagingFailure(
      "Release candidate does not match the validated staging commit.",
      `The validated staging commit is ${validatedCommitSha}, but the prepared release candidate points to ${releaseCandidate.commitSha}. ` +
        "Production was not merged and restart signaling was blocked. The staging worktree is still intact for retry-after-fix.",
      { toolTelemetry: { stagingDir, branch, prodBranch, validatedCommitSha, releaseCandidateSha: releaseCandidate.commitSha } },
    );
  }

  const headResult = await runCommand("git rev-parse HEAD", PRODUCTION_ROOT);
  const preDeploySha = headResult.ok ? headResult.output.trim() : "";
  let rollbackCheckpoint = { sha: "", createdByCurrentOperation: false };
  if (preDeploySha) {
    if (!existsSync(PRODUCTION_DATA_DIR)) mkdirSync(PRODUCTION_DATA_DIR, { recursive: true });
    rollbackCheckpoint = preserveOrCreateRollbackCheckpoint(PRE_DEPLOY_SHA_FILE, preDeploySha);
    writeLog(
      rollbackCheckpoint.createdByCurrentOperation
        ? `Pre-deploy SHA saved: ${rollbackCheckpoint.sha}`
        : `Using preserved pre-deploy SHA: ${rollbackCheckpoint.sha}`,
    );
  }

  const mergeResult = await runCommand(`git merge "${branch}" --no-edit`, PRODUCTION_ROOT);
  if (!mergeResult.ok) {
    await runCommand("git merge --abort", PRODUCTION_ROOT);
    await unstashProduction();
    removeRollbackCheckpointIfCreated(PRE_DEPLOY_SHA_FILE, rollbackCheckpoint);
    return commandFailure(
      "Merge into production failed after rebase.",
      `Merge failed after rebase (unexpected). The merge has been aborted.\n` +
        `Your staging worktree is still intact. Try running 'git rebase ${prodBranch}' ` +
        "in the staging directory to resolve conflicts, then call staging_deploy again.",
      `git merge "${branch}" --no-edit`,
      PRODUCTION_ROOT,
      mergeResult.output,
      { stagingDir, branch, prodBranch },
    );
  }

  const newHead = await runCommand("git rev-parse --short HEAD", PRODUCTION_ROOT);
  const commitSha = newHead.ok ? newHead.output.trim() : "unknown";
  if (
    !newHead.ok
    || !commitSha
    || commitSha === "unknown"
    || !validatedCommitSha.startsWith(commitSha)
  ) {
    let resetFailure = "";
    if (preDeploySha) {
      const resetCommand = `git reset --hard ${preDeploySha}`;
      const resetResult = await runCommand(resetCommand, PRODUCTION_ROOT);
      if (resetResult.ok) {
        removeRollbackCheckpointIfCreated(PRE_DEPLOY_SHA_FILE, rollbackCheckpoint);
        writeLog(`Production checkout reset after validated commit mismatch: ${preDeploySha}`);
      } else {
        resetFailure = joinFailureSections(
          `Reset command: ${resetCommand}`,
          resetResult.output,
        ) ?? resetResult.output;
      }
    }
    await unstashProduction();
    return stagingFailure(
      resetFailure
        ? "Production commit changed after validation and the safety reset failed."
        : "Production commit changed after validation; restart blocked.",
      `The validated staging commit is ${validatedCommitSha}, but merging produced ${commitSha || "an unreadable HEAD"}. ` +
        "The prepared release candidate was not activated because it no longer matched production HEAD." +
        (preDeploySha && !resetFailure
          ? ` The production checkout was reset to ${preDeploySha}; retry staging_deploy so it can rebase and revalidate.`
          : " Manual recovery is required before retrying.") +
        (resetFailure ? `\n\n${resetFailure}` : ""),
      {
        sessionLog: joinFailureSections(
          `Validated staging commit ${validatedCommitSha} did not match merged production HEAD ${commitSha || "unknown"}.`,
          resetFailure,
        ),
        toolTelemetry: {
          stagingDir,
          branch,
          prodBranch,
          validatedCommitSha,
          mergedCommitSha: commitSha,
          ...(preDeploySha && !resetFailure ? { revertedTo: preDeploySha } : {}),
        },
      },
    );
  }
  writeLog(`Merged to production: ${commitSha}`);

  const pkgChanged = await runCommand(`git diff "${preDeploySha}" HEAD --name-only -- ${DEPENDENCY_SYNC_GIT_PATHSPEC}`, PRODUCTION_ROOT);
  if (pkgChanged.ok && pkgChanged.output.trim()) {
    writeLog("Dependency inputs changed — launcher will sync production dependencies during restart");
  }

  let pushResult = await runCommand(`git push origin ${prodBranch}`, PRODUCTION_ROOT);
  if (!pushResult.ok) {
    writeLog("Push failed, retrying the same validated commit without rebasing...");
    pushResult = await runCommand(`git push origin ${prodBranch}`, PRODUCTION_ROOT);
  }
  if (!pushResult.ok) {
    if (preDeploySha) {
      const resetCommand = `git reset --hard ${preDeploySha}`;
      writeLog(`Push failed — resetting production checkout to pre-deploy SHA ${preDeploySha}`);
      const resetResult = await runCommand(resetCommand, PRODUCTION_ROOT);
      if (!resetResult.ok) {
        // Leave the stash in place: popping onto a checkout that could not be
        // reset would layer the user's changes over a broken production tree.
        stash.suppressed = true;
        return commandFailure(
          "Push to origin failed and production reset failed.",
          `The production merge succeeded locally, but pushing ${prodBranch} to origin failed and resetting the local production checkout back to ${preDeploySha} also failed. ` +
            "Restart signaling was blocked, the rollback checkpoint was preserved, and manual recovery is required before retrying. " +
            (stash.pending
              ? `Your uncommitted production changes are stashed as '${stashMarker}' (${stash.sha}); restore them only after recovering the checkout.`
              : "If production changes were stashed, restore them only after recovering the checkout."),
          resetCommand,
          PRODUCTION_ROOT,
          joinFailureSections(pushResult.output, resetResult.output) ?? resetResult.output,
          { stagingDir, branch, prodBranch, commitSha, preDeploySha },
        );
      }
      removeRollbackCheckpointIfCreated(PRE_DEPLOY_SHA_FILE, rollbackCheckpoint);
      writeLog(`Production checkout reset to pre-deploy SHA after push failure: ${preDeploySha}`);
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
  writeLog("Pushed to origin");

  const deployedHeadResult = await runCommand("git rev-parse HEAD", PRODUCTION_ROOT);
  const deployedCommitSha = deployedHeadResult.ok ? deployedHeadResult.output.trim() : "";
  if (
    !deployedCommitSha
    || deployedCommitSha !== validatedCommitSha
    || deployedCommitSha !== releaseCandidate.commitSha
  ) {
    await unstashProduction();
    return stagingFailure(
      "Pushed production commit does not match the validated release candidate.",
      `The push completed, but production HEAD is ${deployedCommitSha || "unreadable"}, the validated commit is ${validatedCommitSha}, ` +
        `and the prepared release candidate is ${releaseCandidate.commitSha}. Restart signaling was blocked so the mismatched release cannot be activated. ` +
        "The rollback checkpoint and staging worktree were preserved for manual recovery.",
      {
        toolTelemetry: {
          stagingDir,
          branch,
          prodBranch,
          deployedCommitSha: deployedCommitSha || "unknown",
          validatedCommitSha,
          releaseCandidateSha: releaseCandidate.commitSha,
        },
      },
    );
  }

  try {
    writeDeployValidationStamp(PRODUCTION_DATA_DIR, {
      commitSha: deployedCommitSha,
      dependencyHash,
      gateId: DEPLOY_GATE.id,
      gateVersion: DEPLOY_GATE_VERSION,
      command: DEPLOY_CHECK_COMMAND,
      source: "staging_deploy",
      validatedAt: new Date().toISOString(),
    });
    writeLog(`Deploy validation stamp written for ${deployedCommitSha}`);
  } catch (error) {
    writeLog(`Deploy validation stamp could not be written; launcher will run the full gate: ${error instanceof Error ? error.message : String(error)}`);
  }

  await unstashProduction();

  const restartDeferred = options.deferDeployRestart === true;
  if (!restartDeferred) {
    if (!existsSync(PRODUCTION_DATA_DIR)) mkdirSync(PRODUCTION_DATA_DIR, { recursive: true });
    try {
      writeRestartSignalOrRollback(SIGNAL_FILE, "deploy", "staging_deploy", releaseCandidate);
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      writeLog(`Restart signal failed after deploy: ${failureMessage}`);
      let cleanupNote = "";
      try {
        await cleanupPreviewArtifactsForStagingDir(stagingDir);
        await removeWorktree(stagingDir, branch);
        deleteStagingValidationStamp(PRODUCTION_DATA_DIR, prefix);
        writeLog("Staging worktree cleaned up after restart signal failure");
      } catch (cleanupErr) {
        cleanupNote = `\n\nPost-deploy cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`;
        writeLog(`Warning: post-deploy cleanup failed after restart signal failure: ${cleanupErr}`);
      }
      return stagingFailure(
        "Deployment pushed but restart signal failed.",
        `Deployment ${commitSha} was pushed to ${prodBranch}, but the launcher restart signal could not be written. Manual restart is required.\n\n${failureMessage}${cleanupNote}`,
        {
          sessionLog: `Deployment ${commitSha} was pushed, but writing ${SIGNAL_FILE} failed: ${failureMessage}${cleanupNote}`,
          toolTelemetry: { stagingDir, branch, prodBranch, commitSha, signalFile: SIGNAL_FILE },
        },
      );
    }
    writeLog("Restart signal sent");
  }

  if (!restartDeferred) {
    try {
      await cleanupCompletedStagingDeploy(stagingDir);
      writeLog("Staging worktree cleaned up");
    } catch (err) {
      writeLog(`Warning: post-deploy cleanup failed (non-fatal): ${err}`);
    }
  }

  const deployElapsedMs = Date.now() - deployStartedAt;
  writeLog(`Deploy completed in ${formatCommandDuration(deployElapsedMs)}`);
  return bridgeToolResult({
    success: true,
    commitSha,
    elapsedMs: deployElapsedMs,
    validationElapsedMs,
    ...(restartDeferred ? { restartDeferred: true, releaseCandidate } : {}),
    terminal: true,
    toolNextAction: "respond",
    retryable: false,
    summary: restartDeferred
      ? `Deployed ${commitSha}; restart is deferred until the current deploy batch finishes.`
      : `Deployed ${commitSha} to production in ${formatCommandDuration(deployElapsedMs)}. Restart signal sent; stop issuing tools so cutover can proceed.`,
  });
}

function activeManagementJobFailure(error: ActiveManagementJobError) {
  return stagingFailure(
    "A deploy/update management job is already active.",
    `Job ${error.activeJob.id} (${error.activeJob.type}) is ${error.activeJob.status}. Wait for it to finish before deploying or updating.`,
    { toolTelemetry: { activeJobId: error.activeJob.id, activeJobType: error.activeJob.type } },
  );
}

function getActiveManagementJob(error: unknown) {
  if (error instanceof ActiveManagementJobError) return error.activeJob;
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "ActiveManagementJobError") {
    return (error as { activeJob?: unknown }).activeJob as ActiveManagementJobError["activeJob"] | undefined;
  }
  return undefined;
}

export const STAGING_TOOLS: BridgeToolDefinition[] = [
  defineBridgeTool("staging_init", {
    description:
      "Create a fresh staging worktree for making code changes to the bridge. " +
      "Returns the staging directory path where you should make all edits. " +
      "Use npm run check:fast plus the focused check lane that matches your edit while iterating. " +
      "Final validation is enforced by staging_preview by default, or by staging_deploy when preview validation was skipped or invalidated.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const prefix = randomBytes(4).toString("hex");
      const stagingDir = join(STAGING_PARENT, prefix);
      const branch = `staging/${prefix}`;

      log(`Creating staging worktree: ${stagingDir} (branch: ${branch})`);

      // Pull latest from origin so the worktree starts from the newest remote state
      const currentBranch = await run("git rev-parse --abbrev-ref HEAD", PRODUCTION_ROOT);
      const branchName = currentBranch.ok ? currentBranch.output.trim() : "main";
      const pullCommand = createGitPullRebaseCommand(branchName);
      const pullResult = await run(pullCommand.displayCommand, PRODUCTION_ROOT, {
        executable: pullCommand.command,
        args: pullCommand.args,
      });
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

  defineBridgeTool("staging_preview", {
    description:
      "Build and serve a preview of the staged frontend changes. " +
      "Queues a management job that runs vite build with a staging base path and makes it available at /staging/<prefix>/ on the main server. " +
      "The live server discovers the built preview from disk and restores the staged backend lazily. " +
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
      return await runStagingPreviewJob(args, { startBackend: true, registerInProcess: true });
    },
  }),

  defineBridgeTool("staging_deploy", {
    description:
      "Deploy validated changes from a staging worktree to production. " +
      "Commits changes in staging (if uncommitted changes exist), rebases the staging branch onto the latest production HEAD, " +
      "merges to main, signals the launcher to restart, and auto-cleans the worktree from a queued management job. " +
      "Supports retries: if a previous deploy failed due to rebase conflicts, resolve them in the staging worktree " +
      "(git rebase <prodBranch>, fix conflicts, git add + git rebase --continue) then call staging_deploy again — " +
      "it will skip the commit step and proceed to merge. " +
      "The runner combines up to 10 queued deploys into one restart. " +
      "Returns immediately with a management job id and Bridge-monitored background status. " +
      "RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: {
      type: "object",
      properties: {
        stagingDir: { type: "string", description: "Path to the staging worktree (returned by staging_init)" },
        message: {
          type: "string",
          description:
            "Commit message describing the changes. Written to the commit verbatim, including any trailers you supply.",
        },
      },
      required: ["stagingDir", "message"],
    },
    handler: async (args: any) => {
      const { stagingDir, message } = args;
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

      if (isRestartAlreadyInFlight(PRODUCTION_DATA_DIR)) {
        return stagingRestartPendingFailure(stagingDir, "deploying");
      }
      return await runStagingDeployJob({ stagingDir, message });
    },
  }),

  defineBridgeTool("staging_cleanup", {
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
];

export interface RegisterStagingToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

function enqueueStagingPreview(ctx: AppContext, args: any) {
  const { stagingDir } = args;
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
  if (isRestartAlreadyInFlight(PRODUCTION_DATA_DIR)) {
    return stagingRestartPendingFailure(stagingDir, "previewing");
  }
  const store = ctx.managementJobStore;
  if (!store) {
    return stagingFailure("Staging preview could not be queued.", "Management job store is not available.");
  }
  try {
    const job = store.enqueue("staging_preview", {
      stagingDir,
      validate: args.validate !== false,
    });
    ctx.stagingPreviewDiscovery?.watchJob(job);
    return queuedManagementJobResult(job, "Staging preview");
  } catch (error) {
    const activeJob = getActiveManagementJob(error);
    if (activeJob) return activeManagementJobFailure({ activeJob } as ActiveManagementJobError);
    return stagingFailure("Staging preview could not be queued.", error instanceof Error ? error.message : String(error));
  }
}

function enqueueStagingDeploy(ctx: AppContext, args: any) {
  const { stagingDir, message } = args;
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
  const store = ctx.managementJobStore;
  if (!store) {
    return stagingFailure("Staging deploy could not be queued.", "Management job store is not available.");
  }
  try {
    const job = store.enqueue("staging_deploy", { stagingDir, message });
    ctx.stagingPreviewDiscovery?.watchJob(job);
    return queuedManagementJobResult(job, "Staging deploy");
  } catch (error) {
    const activeJob = getActiveManagementJob(error);
    if (activeJob) return activeManagementJobFailure({ activeJob } as ActiveManagementJobError);
    return stagingFailure("Staging deploy could not be queued.", error instanceof Error ? error.message : String(error));
  }
}

export function createStagingToolDefinitions(ctx?: AppContext): BridgeToolDefinition[] {
  if (!ctx) return [...STAGING_TOOLS];
  // Rebuild through the adapter rather than patching `handler`, so these tools
  // keep the argument validation every other Bridge tool gets.
  const boundHandlers: Record<string, DefineBridgeToolOptions["handler"]> = {
    staging_preview: (args: any) => enqueueStagingPreview(ctx, args),
    staging_deploy: (args: any) => enqueueStagingDeploy(ctx, args),
  };
  return STAGING_TOOLS.map((tool) => {
    const bound = boundHandlers[tool.name];
    return bound
      ? defineBridgeTool(tool.name, {
        description: tool.description,
        parameters: tool.inputSchema,
        scope: tool.scope,
        handler: bound,
      })
      : tool;
  });
}

export function registerStagingTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterStagingToolsOptions = {},
): void {
  const definitions = createStagingToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
