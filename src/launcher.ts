// Launcher — immortal parent process that manages the bridge server

import "./log-timestamps.js";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dependencySyncHash,
  installedDependencyHashPath,
  preparePatchedPackagesForInstall,
  sweepStalePatchPackageBackups,
} from "./server/dependency-sync.js";
import { buildBridgeChildEnv, loadBridgeEnvManagedKeys } from "./server/env-loader.js";
import { appendLauncherLogLine, getLauncherLogPath } from "./server/launcher-log.js";
import { BRIDGE_CONTROL_ROOT_ENV } from "./server/control-root.js";
import {
  captureProcessIdentity,
  PROCESS_TREE_TERMINATION_BUDGET_MS,
  shouldSpawnDetachedProcessGroup,
  terminateProcessTree,
  type ProcessIdentity,
} from "./server/platform.js";
import {
  createDeadline,
  deadlineBefore,
  remainingMs,
  type Deadline,
} from "./server/deadline.js";
import { resolveBridgePort } from "./server/port-config.js";
import { clearRollbackCheckpoint } from "./server/pre-deploy-checkpoint.js";
import { gitHash } from "./launcher-git.js";
import { runSyncCommand } from "./server/sync-command-runner.js";
import { createValidationCommandEnv, prependNodePath } from "./server/validation-command-env.js";
import { readDeployValidationStamp, validateDeployValidationStamp } from "./server/deploy-validation-stamp.js";
import {
  consumeRestartSignalFile,
  readCurrentRestartSignalFile,
  writeRestartSignalFile,
  type RestartSignal,
  type RestartSignalConsumption,
  type RestartValidationMode,
} from "./server/restart-signal.js";
import {
  pruneReleaseSlots,
  readActiveRelease,
  resolveReleaseCandidate,
  writeActiveRelease,
  type ReleaseSlotManifest,
} from "./server/release-slots.js";
import {
  clearRestartState,
  readRestartState,
  type ReleaseFailurePhase,
  type ReleaseFailureState,
  sweepStaleRestartStateTempFiles,
  writeRestartState,
} from "./server/restart-state.js";
import {
  BRIDGE_ACTIVE_RELEASE_ROOT_ENV,
  BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV,
  resolveBridgeDistribution,
} from "./server/distribution-mode.js";
import { resolveRuntimePaths } from "./server/runtime-paths.js";
import {
  markUpdateInstallActivationFailed,
  markUpdateInstallActivationSucceeded,
} from "./server/update-service.js";
import {
  clearPersistentRollbackFailureState,
  hasPersistentRollbackFailureState,
  markPersistentRollbackFailureState,
} from "./launcher-rollback-state.js";
import {
  didRestartRecover,
  parseRestartBusyState,
  resolveReleaseCandidateRestartOutcome,
  resolveRollbackRecoveryOutcome,
  rollbackRecoveryRequiresServerStart,
  startAfterVerifiedStop,
  shouldPersistReleaseFailureState,
  type RestartOutcome,
} from "./launcher-restart.js";
import {
  createBlockedBackendRecoveryMonitor,
  evaluateHealthPoll,
  evaluatePostRecoveryState,
  evaluateUnexpectedExit,
  readRecoveryBlockedAt,
  shouldIgnoreHealthPollResult,
} from "./launcher-health.js";
import {
  LAUNCHER_CLEANUP_FAILURE_EXIT_CODE,
  LAUNCHER_TERMINAL_EXIT_CODE,
  resolveLauncherShutdownExitCode,
  stopLauncherChild,
  type LauncherChild,
} from "./launcher-exit.js";
import { runLauncherBuild, runLauncherRollbackWithCheckpointHandling, verifyLauncherStartup } from "./launcher-build.js";
import type { LauncherCommandOptions } from "./launcher-build.js";
import { DEPLOY_CHECK_COMMAND, DEPLOY_GATE, DEPLOY_GATE_VERSION } from "./server/validation-pipeline.js";
import {
  decideLauncherStartup,
  decideRecoveryExecution,
  shouldCheckFollowUpRecovery,
  shouldClearRollbackCheckpointAfterHealthyState,
} from "./launcher-recovery.js";
import {
  attachLauncherChildErrorHandler,
  isChildProcessActive,
  LAUNCHER_STARTUP_GIT_PULL_ENV,
  resolveServerLaunchDistributionMode,
  shouldPullOnLauncherStartup,
  spawnLauncherChildIfRunning,
  waitForChildExit,
} from "./launcher-process.js";
import {
  planTunnelSupervisors,
  TunnelSupervisor,
} from "./launcher-tunnel-supervisor.js";
import { createGitHubTunnelHostAuth } from "./launcher-github-tunnel-auth.js";
import { resolveTunnelConfig } from "./server/tunnel-config.js";
import { listAdditionalTunnelRuntimeStateNames } from "./server/tunnel-runtime-state.js";
import { withNonInteractiveCommandEnv } from "./server/noninteractive-env.js";
import { createGitPullRebaseCommand } from "./server/git-command.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BRIDGE_ENV_PATH = process.env.BRIDGE_ENV_FILE?.trim() || undefined;
const MANAGED_ENV_KEYS = new Set(loadBridgeEnvManagedKeys(BRIDGE_ENV_PATH));
const RUNTIME_PATHS = resolveRuntimePaths(process.env);
Object.assign(process.env, RUNTIME_PATHS.env);
const DISTRIBUTION = resolveBridgeDistribution(process.env, ROOT);
const DATA_DIR = RUNTIME_PATHS.dataDir;
const NODE_PATH = process.execPath; // use the same node binary that's running the launcher
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SIGNAL_FILE = join(DATA_DIR, "restart.signal");
const IN_PROGRESS_SIGNAL_FILE = join(DATA_DIR, "restart-in-progress.json");
const RESTART_STATE_FILE = join(DATA_DIR, "restart-state.json");
const PRE_DEPLOY_SHA_FILE = join(DATA_DIR, "pre-deploy-sha");
const FAILED_ROLLBACK_STATE_FILE = join(DATA_DIR, "rollback-required");
const SOURCE_SERVER_ENTRY = "src/server/index.ts";
const COMPILED_SERVER_ENTRY = "dist/server/index.js";
const SOURCE_MANAGEMENT_JOB_RUNNER_ENTRY = "src/management-job-runner.ts";
const COMPILED_MANAGEMENT_JOB_RUNNER_ENTRY = "dist/management-job-runner.js";
if (!process.env.BRIDGE_LAUNCHER_LOG_PATH) {
  process.env.BRIDGE_LAUNCHER_LOG_PATH = join(DATA_DIR, "launcher.log");
}
const LAUNCHER_LOG_PATH = getLauncherLogPath();
const MAX_FAILURES = 3;
const POLL_INTERVAL = 2_000;
const HEALTH_TIMEOUT = 120_000;
const HEALTH_POLL_INTERVAL = 30_000;
const HEALTH_POLL_TIMEOUT = 5_000;
/**
 * Steady-state polls wait this long for an answer. A timeout only proves the event loop was busy
 * for that long: a server stalled by machine load is alive, and killing it destroys every
 * in-flight session run to fix nothing. Only a server that stays silent this long is treated as hung.
 */
const HEALTH_STEADY_POLL_TIMEOUT = 60_000;
const HEALTH_FAILURE_THRESHOLD = 3;
/** How long the server may report blocked agent backend recovery before the launcher restarts it. */
const BLOCKED_BACKEND_RECOVERY_GRACE_MS = 60_000;
const BLOCKED_BACKEND_RECOVERY_MAX_RESTARTS = 3;
const BLOCKED_BACKEND_RECOVERY_RESTART_WINDOW_MS = 60 * 60_000;

const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL || "";
const WEBHOOK_TIMEOUT_MS = 10_000;

const IDLE_PROBE_TIMEOUT = 10_000; // an unanswered idle probe counts as busy
const GRACEFUL_EXIT_WAIT = 15_000; // wait for clean exit after POST /api/shutdown
const GRACEFUL_SHUTDOWN_REQUEST_TIMEOUT = 5_000; // bound shutdown POST so force-kill fallback is reachable
const CHILD_IDENTITY_CAPTURE_TIMEOUT_MS = 10_000;
const CRASH_RESTART_DELAY = 5_000;
const MAX_CRASH_RESTARTS = 5;
const CRASH_WINDOW = 60_000; // reset crash counter after 60s of stability
const OPERATIONAL_RESTART_SOURCE_PATHS = [
  "package.json",
  "package-lock.json",
  "patches",
  "public",
  "scripts",
  "src",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
];

const DEPENDENCY_INSTALL_TIMEOUT = 600_000;

let serverProcess: ChildProcess | null = null;
let serverLaunchTarget: ServerLaunchTarget | null = null;
let managementJobRunnerProcess: ChildProcess | null = null;
const childProcessIdentities = new WeakMap<ChildProcess, Promise<ProcessIdentity | null>>();
let consecutiveFailures = 0;
let restarting = false;
let restartCheckInFlight = false;
let shuttingDown = false;
let lastRestartWaitLog = "";
let restartSignalClaimed = false;
let crashRestarts = 0;
let lastCrashTime = 0;
let steadyHealthFailures = 0;
let healthPollInFlight = false;
let recoveringServer = false;
let suppressAutoRecovery = readPersistentRollbackSuppression();
let currentServerPort = resolveBridgePort();
let lastCommandFailure:
  | {
      command: string;
      validationLogPath?: string;
      validationLogWriteError?: string;
    }
  | null = null;
let lastRollbackTarget: string | null = null;
let pendingReleaseFailure: ReleaseFailureState | null = null;
let releaseCandidateSha: string | null = null;
let terminalShutdownPromise: Promise<number> | null = null;
const tunnelConfig = resolveTunnelConfig(process.env);
const githubTunnelHostAuth = createGitHubTunnelHostAuth();
const allTunnelSupervisors = planTunnelSupervisors(
  tunnelConfig.tunnels,
  listAdditionalTunnelRuntimeStateNames(DATA_DIR),
).map(({ auth, ...plan }, index) => new TunnelSupervisor({
  dataDir: DATA_DIR,
  port: currentServerPort,
  log,
  ...plan,
  ...(auth === "github" ? { hostAuth: githubTunnelHostAuth } : {}),
  ...(index === 0 ? { onReady: (url: string) => notifyWebhook("🔗 Copilot Bridge public URL ready", url) } : {}),
}));
const tunnelSupervisor = allTunnelSupervisors[0];
const blockedBackendRecovery = createBlockedBackendRecoveryMonitor({
  graceMs: BLOCKED_BACKEND_RECOVERY_GRACE_MS,
  maxRestarts: BLOCKED_BACKEND_RECOVERY_MAX_RESTARTS,
  windowMs: BLOCKED_BACKEND_RECOVERY_RESTART_WINDOW_MS,
  log,
  notify: (message) => {
    void notifyWebhook(`${message} (${tag()})`, tunnelSupervisor.getUrl());
  },
  // The HTTP server is responsive, so only the verified force-kill path can also
  // take down a runtime that fencing could not prove gone.
  restart: (reason) => recoverServer(reason, { killExisting: true }),
  isAutoRecoverySuppressed: () => suppressAutoRecovery,
});

type ServerLaunchTarget = {
  root: string;
  entry: string;
  mode: "source" | "compiled";
  release?: ReleaseSlotManifest;
};

type HealthProbeResult = {
  healthy: boolean;
  failureDetail?: string;
  durationMs?: number;
  /** When the server reported that agent backend recovery is blocked. */
  recoveryBlockedAt?: string | null;
};

function log(msg: string) {
  const line = `[launcher] ${msg}`;
  console.log(line);
  appendLauncherLogLine(line);
}

function bridgeLocalUrl(pathname: string, port = currentServerPort): string {
  return `http://localhost:${port}${pathname}`;
}

function commandEnv(): NodeJS.ProcessEnv {
  return withNonInteractiveCommandEnv(process.env);
}

function gitFullHash(): string | null {
  try {
    const value = execSync("git --no-pager rev-parse HEAD", {
      cwd: ROOT,
      encoding: "utf-8",
      env: commandEnv(),
      timeout: 5_000,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function normalizeGitHash(value: string): string | null {
  return value && value !== "unknown" ? value : null;
}

const tag = () => `${gitHash()}, PID ${process.pid}`;

function clearFile(filePath: string) {
  try { if (existsSync(filePath)) unlinkSync(filePath); } catch {}
}

function clearSignal() {
  clearFile(SIGNAL_FILE);
}

function clearInProgressSignal() {
  clearFile(IN_PROGRESS_SIGNAL_FILE);
}

function clearInProgressSignalStrict(): Error | null {
  try {
    unlinkSync(IN_PROGRESS_SIGNAL_FILE);
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function markReleaseUpdateActivationSucceeded(candidateId: string): void {
  if (markUpdateInstallActivationSucceeded({ runtimePaths: RUNTIME_PATHS, candidateId })) {
    log(`Marked release update candidate ${candidateId} as activated`);
  }
}

function markReleaseUpdateActivationFailed(candidateId: string, message: string): void {
  if (markUpdateInstallActivationFailed({ runtimePaths: RUNTIME_PATHS, candidateId, message })) {
    log(`Marked release update candidate ${candidateId} as failed: ${message}`);
  }
}

function markReleaseUpdateActivationRejected(candidateId: string, message: string): void {
  if (markUpdateInstallActivationFailed({ runtimePaths: RUNTIME_PATHS, candidateId, message })) {
    log(`Marked release update candidate ${candidateId} as rejected: ${message}`);
  }
}

function restorePendingRestartSignal() {
  if (!existsSync(IN_PROGRESS_SIGNAL_FILE)) return;
  if (existsSync(SIGNAL_FILE)) {
    const error = clearInProgressSignalStrict();
    if (error) throw error;
  } else {
    renameSync(IN_PROGRESS_SIGNAL_FILE, SIGNAL_FILE);
    log("Restored an unfinished restart request from the previous launcher");
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

type LauncherRunOptions = LauncherCommandOptions & {
  executable?: string;
  args?: readonly string[];
};

function run(cmd: string, options: LauncherRunOptions = {}): { ok: boolean; output: string } {
  // Prepend the launcher's Node v22 directory to PATH so npx/vitest use it
  const nodeDir = dirname(NODE_PATH);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const validationEnv = options.isolateRuntimeEnv
    ? createValidationCommandEnv(process.env, { nodeDir, prefix: "bridge-launcher-validation-" })
    : undefined;
  const env = withNonInteractiveCommandEnv(validationEnv?.env ?? prependNodePath(process.env, nodeDir));
  try {
    const result = runSyncCommand({
      rootDir: ROOT,
      source: "launcher",
      command: options.executable ?? cmd,
      args: options.args,
      displayCommand: cmd,
      cwd: ROOT,
      env,
      timeoutMs,
      shell: options.args ? false : undefined,
    });
    if (result.ok) {
      lastCommandFailure = null;
    } else {
      lastCommandFailure = {
        command: cmd,
        validationLogPath: result.validationLogPath,
        validationLogWriteError: result.validationLogWriteError,
      };
    }
    return { ok: result.ok, output: result.output };
  } finally {
    validationEnv?.cleanup();
  }
}

const DEPS_HASH_FILE = installedDependencyHashPath(DATA_DIR);

/** Hash package files and patch-package inputs to detect dependency changes. */
function depsHash(): string {
  return dependencySyncHash(ROOT);
}

function dependencyInputsChangedSinceLastSync(): boolean {
  try {
    return !existsSync(DEPS_HASH_FILE) || readFileSync(DEPS_HASH_FILE, "utf-8").trim() !== depsHash();
  } catch {
    return true;
  }
}

/** Run npm install if dependency inputs have changed since last install. */
function ensureDeps(): boolean {
  if (DISTRIBUTION.mode === "release") {
    log("Release mode - skipping source dependency sync");
    return true;
  }

  const current = depsHash();
  try {
    if (existsSync(DEPS_HASH_FILE) && readFileSync(DEPS_HASH_FILE, "utf-8").trim() === current) {
      return true; // deps are in sync
    }
  } catch {}

  const prepared = preparePatchedPackagesForInstall(ROOT);
  if (prepared.packages.length > 0) {
    log(`Prepared patched packages for npm install: ${prepared.packages.join(", ")}`);
  }

  log("Dependencies changed — running npm install...");
  const result = run("npm install --no-audit --no-fund --include=dev", {
    timeoutMs: DEPENDENCY_INSTALL_TIMEOUT,
  });
  if (!result.ok) {
    prepared.restore();
    log(`npm install failed: ${result.output.slice(-500)}`);
    return false;
  }
  prepared.discard();
  // Update stored hash
  const dataDir = DATA_DIR;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(DEPS_HASH_FILE, current);
  log("npm install succeeded — deps hash updated");
  return true;
}

/**
 * A prepared release slot ships its own node_modules, so activating it skips the
 * production-root build. Staging worktrees still link their node_modules into the
 * production root, so bring it up to date with the now-active dependency inputs;
 * staging falls back to its own install if this fails.
 */
function syncProductionRootDepsAfterReleaseActivation(): void {
  if (DISTRIBUTION.mode === "release" || !dependencyInputsChangedSinceLastSync()) return;
  log("Production-root dependencies lag the activated release — syncing...");
  if (!ensureDeps()) {
    log("Production-root dependency sync failed — staging worktrees will install their own dependencies");
  }
}

function hasOperationalRestartSourceChanges(): boolean {
  if (dependencyInputsChangedSinceLastSync()) {
    return true;
  }

  if (DISTRIBUTION.mode !== "development" || !DISTRIBUTION.gitAvailable) {
    return false;
  }

  const pathspec = OPERATIONAL_RESTART_SOURCE_PATHS.join(" ");
  const env = commandEnv();
  try {
    execSync(`git --no-pager diff --quiet HEAD -- ${pathspec}`, {
      cwd: ROOT,
      encoding: "utf-8",
      env,
      timeout: 10_000,
    });
    const untracked = execSync(`git --no-pager ls-files --others --exclude-standard -- ${pathspec}`, {
      cwd: ROOT,
      encoding: "utf-8",
      env,
      timeout: 10_000,
    }).trim();
    return untracked.length > 0;
  } catch (error: any) {
    if (error?.status === 1) {
      return true;
    }
    log(`Unable to determine operational restart source changes — running deploy validation: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

function build(validationMode: RestartValidationMode): boolean {
  if (DISTRIBUTION.mode === "release") {
    log("Release mode - skipping source validation build");
    return true;
  }
  return runLauncherBuild({
    ensureDeps,
    run,
    log,
    validationMode,
    hasSourceChanges: hasOperationalRestartSourceChanges,
    resolveDeployValidationStamp: () => {
      if (hasOperationalRestartSourceChanges()) {
        return { valid: false, reason: "production source has uncommitted changes" };
      }
      const commitSha = gitFullHash();
      if (!commitSha) return { valid: false, reason: "could not resolve current HEAD" };
      const stamp = validateDeployValidationStamp(readDeployValidationStamp(DATA_DIR), {
        commitSha,
        dependencyHash: depsHash(),
        gateId: DEPLOY_GATE.id,
        gateVersion: DEPLOY_GATE_VERSION,
        command: DEPLOY_CHECK_COMMAND,
      });
      return stamp.valid
        ? { valid: true, commitSha }
        : { valid: false, reason: stamp.reason };
    },
  });
}

function rollback(): boolean {
  if (DISTRIBUTION.mode === "release") {
    log("Release mode - git rollback is unavailable; packaged updater rollback must restore the previous app version");
    return false;
  }
  log("Rolling back to last checkpoint...");
  const preDeployFile = PRE_DEPLOY_SHA_FILE;
  let rollbackTarget = "HEAD";
  let checkpointContents: string | null = null;
  try {
    if (existsSync(preDeployFile)) {
      checkpointContents = readFileSync(preDeployFile, "utf-8");
      const sha = checkpointContents.trim();
      if (sha) {
        rollbackTarget = sha;
        log(`Rolling back to pre-deploy state: ${sha}`);
      }
    }
  } catch {}
  lastRollbackTarget = rollbackTarget;
  return runLauncherRollbackWithCheckpointHandling({
    rollbackTarget,
    ensureDeps,
    run,
    log,
    clearCheckpoint: () => {
      if (checkpointContents === null) return;
      try {
        unlinkSync(preDeployFile);
      } catch {}
    },
    restoreCheckpoint: () => {
      if (checkpointContents === null) return;
      try {
        writeFileSync(preDeployFile, checkpointContents);
      } catch {}
    },
  });
}

function enterStoppedStateAfterFailedRollback() {
  try {
    markPersistentRollbackFailureState(FAILED_ROLLBACK_STATE_FILE);
  } catch (error) {
    log(`Failed to persist rollback-required state; auto-recovery remains suppressed in this launcher process: ${error}`);
  }
  suppressAutoRecovery = true;
}

function clearFailedRollbackState() {
  try {
    clearPersistentRollbackFailureState(FAILED_ROLLBACK_STATE_FILE);
  } catch (error) {
    log(`Failed to clear rollback-required state; auto-recovery remains suppressed: ${error}`);
    return;
  }
  suppressAutoRecovery = false;
}

function readPersistentRollbackSuppression(): boolean {
  try {
    return hasPersistentRollbackFailureState(FAILED_ROLLBACK_STATE_FILE);
  } catch (error) {
    log(`Failed to read rollback-required state; auto-recovery will remain suppressed: ${error}`);
    return true;
  }
}

function clearRollbackCheckpointAfterHealthyState() {
  if (!shouldClearRollbackCheckpointAfterHealthyState({
    restartSignalPresent: existsSync(SIGNAL_FILE),
    autoRecoverySuppressed: suppressAutoRecovery,
  })) {
    return;
  }
  clearRollbackCheckpoint(PRE_DEPLOY_SHA_FILE);
}

/** Write restart state without throwing — state writes are monitoring aids, not critical path. */
async function safeWriteRestartState(state: Parameters<typeof writeRestartState>[1]): Promise<void> {
  try {
    await writeRestartState(RESTART_STATE_FILE, state);
  } catch (err) {
    log(`Failed to write restart state (non-fatal): ${err}`);
  }
}

/** Clear restart state without throwing. */
async function safeClearRestartState(): Promise<void> {
  try {
    await clearRestartState(RESTART_STATE_FILE);
  } catch (err) {
    log(`Failed to clear restart state (non-fatal): ${err}`);
  }
}

function captureReleaseFailureMetadata(): {
  command: string | null;
  validationLogPath: string | null;
  commitSha: string | null;
  rollbackTarget: string | null;
} {
  return {
    command: lastCommandFailure?.command ?? null,
    validationLogPath: lastCommandFailure?.validationLogPath ?? null,
    commitSha: releaseCandidateSha ?? normalizeGitHash(gitHash()),
    rollbackTarget: lastRollbackTarget,
  };
}

function setPendingReleaseFailure(
  phase: ReleaseFailurePhase,
  event: ReleaseFailureState["event"],
  message: string,
): ReleaseFailureState {
  const metadata = captureReleaseFailureMetadata();
  pendingReleaseFailure = {
    event,
    phase,
    failedAt: new Date().toISOString(),
    message,
    command: metadata.command,
    validationLogPath: metadata.validationLogPath,
    commitSha: metadata.commitSha,
    rollbackTarget: metadata.rollbackTarget,
  };
  return pendingReleaseFailure;
}

function clearReleaseFailureTracking(): void {
  pendingReleaseFailure = null;
  lastCommandFailure = null;
  lastRollbackTarget = null;
}

function formatReleaseFailureMessage(
  failure: ReleaseFailureState,
  options: { includeTag?: boolean } = {},
): string {
  return [
    failure.message,
    failure.command ? `Command: ${failure.command}` : undefined,
    failure.validationLogPath ? `Full command output: ${failure.validationLogPath}` : undefined,
    failure.commitSha ? `Failed release: ${failure.commitSha}` : undefined,
    failure.rollbackTarget ? `Rollback target: ${failure.rollbackTarget}` : undefined,
    options.includeTag ? tag() : undefined,
  ].filter((part): part is string => Boolean(part)).join(" — ");
}

async function safePersistPendingReleaseFailure(): Promise<void> {
  if (!pendingReleaseFailure) return;
  try {
    await writeRestartState(RESTART_STATE_FILE, { phase: "idle", releaseFailure: pendingReleaseFailure });
  } catch (err) {
    log(`Failed to persist release failure state (non-fatal): ${err}`);
  }
}

async function noteManualInterventionRequired(
  phase: ReleaseFailurePhase,
  message: string,
): Promise<void> {
  const failure = setPendingReleaseFailure(phase, "launcher-manual-intervention-required", message);
  await safePersistPendingReleaseFailure();
  await notifyWebhook(`❌ ${formatReleaseFailureMessage(failure, { includeTag: true })}`, tunnelSupervisor.getUrl());
}

async function noteRetryBudgetExhausted(
  phase: ReleaseFailurePhase,
  reason: string,
): Promise<never> {
  const failure = setPendingReleaseFailure(
    phase,
    "launcher-retry-budget-exhausted",
    `Launcher exhausted retry budget after ${MAX_FAILURES} consecutive failures (${reason}).`,
  );
  await safePersistPendingReleaseFailure();
  await notifyWebhook(`❌ ${formatReleaseFailureMessage(failure, { includeTag: true })}`, tunnelSupervisor.getUrl());
  return await shutdownAndExit(LAUNCHER_TERMINAL_EXIT_CODE, "retry budget exhausted");
}

async function recordFailureAndMaybeStop(
  phase: ReleaseFailurePhase,
  options: { manualInterventionMessage?: string; retryReason: string },
): Promise<void> {
  if (options.manualInterventionMessage) {
    await noteManualInterventionRequired(phase, options.manualInterventionMessage);
  }
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    log(`❌ ${MAX_FAILURES} consecutive failures — stopping`);
    await noteRetryBudgetExhausted(phase, options.retryReason);
  }
}

function rejectInvalidRestartSignal(
  result: Extract<RestartSignalConsumption, { status: "invalid" }>,
): void {
  const message = `Restart signal is invalid: ${result.error.message}. No restart was attempted.`;
  log(`❌ ${message}`);
  if (result.releaseCandidateId) {
    markReleaseUpdateActivationRejected(result.releaseCandidateId, message);
  }
  const clearError = clearInProgressSignalStrict();
  if (clearError) {
    log(
      `Failed to remove rejected restart claim ${IN_PROGRESS_SIGNAL_FILE}: ${clearError.message}. `
      + "Remove the file manually after confirming no restart is running.",
    );
  }
}

/**
 * Whether the Bridge has nothing in flight: no run, no session being created, no queued or running
 * management job. A pending restart blocks nothing and simply asks again on the next poll, for as
 * long as it takes. An unanswered probe counts as busy; a hung server is the health poll's to recover.
 */
async function isBridgeIdle(): Promise<boolean> {
  if (!serverProcess) return true;
  let reason = "the server is not answering";
  try {
    const response = await fetch(bridgeLocalUrl("/api/busy"), { signal: AbortSignal.timeout(IDLE_PROBE_TIMEOUT) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const busy = parseRestartBusyState(await response.json());
    if (!busy.busy) return true;
    const jobs = busy.jobs;
    const sessions = busy.count - jobs;
    const work = [
      sessions > 0 ? `${sessions} active operation(s)` : "",
      jobs > 0 ? `${jobs} management job(s)` : "",
    ].filter(Boolean).join(" and ") || "active work";
    reason = `waiting for ${work} to finish`;
  } catch (error) {
    if (!serverProcess) return true;
    reason = `idle check failed (will retry): ${error instanceof Error ? error.message : String(error)}`;
  }
  if (reason !== lastRestartWaitLog) {
    log(`Restart pending — ${reason}`);
    lastRestartWaitLog = reason;
  }
  return false;
}

/**
 * Acts on a pending restart request. The request stays where it is until the Bridge is idle, so
 * later requests keep joining it; it is claimed only once the server has agreed to stop.
 * `force` skips the wait: the server is already gone or is being replaced because it is unhealthy.
 */
async function processRestartSignal(force = false): Promise<void> {
  if (restartCheckInFlight || restarting || shuttingDown) return;
  restartCheckInFlight = true;
  restartSignalClaimed = false;
  let restartOutcome: RestartOutcome = "waiting";
  try {
    let signal: RestartSignal;
    try {
      const current = readCurrentRestartSignalFile(SIGNAL_FILE, IN_PROGRESS_SIGNAL_FILE);
      if (!current) return;
      signal = current;
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code !== "ENOENT") log(`Failed to read restart signal (will retry): ${error.message}`);
        return;
      }
      const claim = consumeRestartSignalFile(SIGNAL_FILE, IN_PROGRESS_SIGNAL_FILE);
      if (claim.status === "invalid") rejectInvalidRestartSignal(claim);
      else if (claim.status === "claimed") {
        // A valid request replaced the unreadable one in between: it goes back to waiting.
        writeRestartSignalFile(SIGNAL_FILE, claim.signal);
        clearInProgressSignal();
      }
      return;
    }
    if (!force && !(await isBridgeIdle())) return;
    lastRestartWaitLog = "";
    if (force) restarting = true;
    restartOutcome = await restart(signal, force);
  } catch (error) {
    restartOutcome = "failed";
    throw error;
  } finally {
    const restartRan = restartSignalClaimed;
    if (restartRan && restartOutcome !== "waiting") {
      const clearError = clearInProgressSignalStrict();
      if (clearError) {
        log(
          `Failed to remove completed restart claim ${IN_PROGRESS_SIGNAL_FILE}: ${clearError.message}. `
          + "Remove the file manually after confirming the restart outcome.",
        );
      }
      if (shouldPersistReleaseFailureState({
        outcome: restartOutcome,
        hasPendingReleaseFailure: pendingReleaseFailure !== null,
      })) {
        await safePersistPendingReleaseFailure();
      } else {
        await safeClearRestartState();
      }
    }
    restarting = false;
    restartCheckInFlight = false;
    if (restartRan && didRestartRecover(restartOutcome)) {
      clearFailedRollbackState();
      clearRollbackCheckpointAfterHealthyState();
    }
    if (shouldCheckFollowUpRecovery({ autoRecoverySuppressed: suppressAutoRecovery })) {
      const followUpRecovery = evaluatePostRecoveryState({
        hasServerProcess: serverProcess !== null,
        restarting,
        recoveringServer,
        shuttingDown,
      });
      if (followUpRecovery) recoverServer(followUpRecovery.reason, followUpRecovery.options);
    }
  }
}

async function probeServerHealth(timeoutMs: number): Promise<HealthProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(bridgeLocalUrl("/api/health"), { signal: controller.signal });
    const durationMs = Date.now() - startedAt;
    if (res.ok) {
      const body = await res.json().catch(() => null);
      return { healthy: true, durationMs, recoveryBlockedAt: readRecoveryBlockedAt(body) };
    }
    return { healthy: false, failureDetail: `HTTP ${res.status} after ${durationMs}ms` };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (timedOut) {
      return {
        healthy: false,
        failureDetail: `timed out after ${durationMs}ms (limit ${timeoutMs}ms)`,
      };
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { healthy: false, failureDetail: `${message} after ${durationMs}ms` };
  } finally {
    clearTimeout(timeout);
  }
}

async function healthCheck(expectedChild: ChildProcess | null = serverProcess): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT) {
    if (expectedChild && !isChildProcessActive(expectedChild, serverProcess)) {
      return false;
    }
    if ((await probeServerHealth(HEALTH_POLL_TIMEOUT)).healthy) {
      return expectedChild ? isChildProcessActive(expectedChild, serverProcess) : true;
    }
    if (expectedChild && !isChildProcessActive(expectedChild, serverProcess)) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

function reserveRecoveryAttempt(): number | null {
  const now = Date.now();
  if (now - lastCrashTime > CRASH_WINDOW) {
    crashRestarts = 0;
  }
  lastCrashTime = now;
  crashRestarts++;

  if (crashRestarts > MAX_CRASH_RESTARTS) {
    log(`❌ ${crashRestarts} crashes in quick succession — not restarting. Manual intervention needed.`);
    return null;
  }

  return crashRestarts;
}

function recoverServer(reason: string, options: { killExisting?: boolean; delayMs?: number } = {}): void {
  const recoveryExecution = decideRecoveryExecution({
    restartSignalPresent: existsSync(SIGNAL_FILE),
    autoRecoverySuppressed: suppressAutoRecovery,
  });
  if (recoveryExecution.type === "restart") {
    // The server is gone or is being replaced as unhealthy, so there is no work to wait for.
    processRestartSignal(true).catch((error) => {
      log(`Recovery restart failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return;
  }
  if (recoveryExecution.type === "skip") {
    log(recoveryExecution.logMessage);
    return;
  }

  const attempt = reserveRecoveryAttempt();
  if (!attempt) return;

  const delayMs = options.delayMs ?? 0;
  log(
    `⚡ ${reason}. Auto-restarting${delayMs > 0 ? ` in ${delayMs / 1000}s` : ""}... ` +
      `(attempt ${attempt}/${MAX_CRASH_RESTARTS})`,
  );

  const runRecovery = async () => {
    if (restarting || shuttingDown || recoveringServer) return;
    recoveringServer = true;
    try {
      if (options.killExisting) {
        const stopped = await forceKillServerAndWait("Stopping unhealthy server...");
        if (!stopped) {
          return;
        }
      } else if (serverProcess) {
        return;
      }
      const replacementServer = startServer();
      if (!replacementServer) return;
      serverProcess = replacementServer;
      const healthy = await healthCheck(replacementServer);
      if (shuttingDown) return;
      if (healthy) {
        steadyHealthFailures = 0;
        clearRollbackCheckpointAfterHealthyState();
        log(`✅ Auto-restart succeeded after ${reason}`);
        await notifyWebhook(
          `⚡ Copilot Bridge auto-restarted after ${reason} (attempt ${attempt}/${MAX_CRASH_RESTARTS}, ${tag()})`,
          tunnelSupervisor.getUrl(),
        );
      } else {
        log(`❌ Auto-restart failed health check after ${reason}`);
        await forceKillServerAndWait("Stopping failed auto-restart...");
      }
    } finally {
      recoveringServer = false;
      if (shouldCheckFollowUpRecovery({ autoRecoverySuppressed: suppressAutoRecovery })) {
        const followUpRecovery = evaluatePostRecoveryState({
          hasServerProcess: serverProcess !== null,
          restarting,
          recoveringServer,
          shuttingDown,
        });
        if (followUpRecovery) {
          recoverServer(followUpRecovery.reason, followUpRecovery.options);
        }
      }
    }
  };

  if (delayMs > 0) {
    setTimeout(() => {
      void runRecovery();
    }, delayMs);
  } else {
    void runRecovery();
  }
}

async function pollServerHealth(): Promise<void> {
  if (healthPollInFlight || restarting || shuttingDown || recoveringServer) return;

  const polledServer = serverProcess;
  healthPollInFlight = true;
  try {
    let healthResult: HealthProbeResult = {
      healthy: false,
      failureDetail: "server process missing",
    };
    if (polledServer) {
      healthResult = await probeServerHealth(HEALTH_STEADY_POLL_TIMEOUT);
    }

    if (
      shouldIgnoreHealthPollResult({
        pollTargetChanged: serverProcess !== polledServer,
        restarting,
        shuttingDown,
        recoveringServer,
      })
    ) {
      return;
    }

    const decision = evaluateHealthPoll({
      healthy: healthResult.healthy,
      hasServerProcess: polledServer !== null,
      consecutiveFailures: steadyHealthFailures,
      failureThreshold: HEALTH_FAILURE_THRESHOLD,
      failureDetail: healthResult.failureDetail,
    });
    steadyHealthFailures = decision.nextFailures;

    if (healthResult.healthy) {
      if ((healthResult.durationMs ?? 0) > HEALTH_POLL_TIMEOUT) {
        log(`Health check slow: answered after ${healthResult.durationMs}ms (server is alive; not a failure)`);
      }
      clearRollbackCheckpointAfterHealthyState();
      if (blockedBackendRecovery.observe(healthResult.recoveryBlockedAt ?? null, Date.now()) === "restarting") {
        return;
      }
    }

    if (!decision.logMessage) {
      return;
    }

    log(decision.logMessage);
    if (decision.recover) {
      recoverServer(decision.recover.reason, { killExisting: decision.recover.killExisting });
    }
  } finally {
    healthPollInFlight = false;
  }
}

function sourceLaunchTarget(): ServerLaunchTarget {
  const mode = DISTRIBUTION.mode === "release" ? "compiled" : "source";
  return {
    root: ROOT,
    entry: join(ROOT, mode === "source" ? SOURCE_SERVER_ENTRY : COMPILED_SERVER_ENTRY),
    mode,
  };
}

function releaseLaunchTarget(release: ReleaseSlotManifest): ServerLaunchTarget {
  return {
    root: release.root,
    entry: join(release.root, COMPILED_SERVER_ENTRY),
    mode: "compiled",
    release,
  };
}

function resolveStartupLaunchTarget(): ServerLaunchTarget {
  const activeRelease = readActiveRelease(DATA_DIR);
  if (activeRelease) {
    return releaseLaunchTarget(activeRelease);
  }
  return sourceLaunchTarget();
}

function describeLaunchTarget(target: ServerLaunchTarget): string {
  return target.release
    ? `release slot ${target.release.id} (${target.release.commitSha.slice(0, 8)})`
    : DISTRIBUTION.mode === "release" ? "packaged release" : "source checkout";
}

function startServer(target: ServerLaunchTarget = resolveStartupLaunchTarget()): ChildProcess | null {
  if (shuttingDown) return null;
  const env = buildBridgeChildEnv(process.env, MANAGED_ENV_KEYS, BRIDGE_ENV_PATH, {
    BRIDGE_DATA_DIR: DATA_DIR,
    BRIDGE_DISTRIBUTION_MODE: resolveServerLaunchDistributionMode(DISTRIBUTION.mode, target.release !== undefined),
    [BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV]: DISTRIBUTION.mode,
    [BRIDGE_CONTROL_ROOT_ENV]: ROOT,
    ...(target.release ? {
      [BRIDGE_ACTIVE_RELEASE_ROOT_ENV]: target.root,
      BRIDGE_RELEASE_SLOT_ID: target.release.id,
    } : {}),
  });
  const port = resolveBridgePort(env);
  currentServerPort = port;
  for (const supervisor of allTunnelSupervisors) supervisor.updatePort(port);
  log(`Starting server on port ${port} from ${describeLaunchTarget(target)}...`);
  env.BRIDGE_LAUNCHER_LOG_PATH = LAUNCHER_LOG_PATH;
  const serverArgs = target.mode === "source" ? [TSX_CLI, target.entry] : [target.entry];
  const child = spawnLauncherChildIfRunning(
    () => shuttingDown,
    () => spawn(NODE_PATH, serverArgs, {
      cwd: target.root,
      stdio: ["ignore", "inherit", "inherit"],
      env,
      detached: shouldSpawnDetachedProcessGroup(),
    }),
  );
  if (!child) return null;
  trackChildProcessIdentity(child);
  serverLaunchTarget = target;
  steadyHealthFailures = 0;

  child.on("exit", (code, signal) => {
    log(`Server exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
    const wasActive = serverProcess === child;
    if (wasActive) {
      serverProcess = null;
      serverLaunchTarget = null;
    }
    if (!wasActive) return;

    const recovery = evaluateUnexpectedExit({
      code,
      signal,
      restarting,
      shuttingDown,
      recoveringServer,
      crashRestartDelay: CRASH_RESTART_DELAY,
    });
    if (recovery) {
      recoverServer(recovery.reason, recovery.options);
    }
  });
  attachLauncherChildErrorHandler(child, {
    label: "Server",
    log,
    onSpawnFailure: () => {
      if (serverProcess !== child) return;
      serverProcess = null;
      serverLaunchTarget = null;
      recoverServer("Server failed to spawn", { delayMs: CRASH_RESTART_DELAY });
    },
  });

  return child;
}

function managementJobRunnerArgs(): string[] {
  const sourceEntry = join(ROOT, SOURCE_MANAGEMENT_JOB_RUNNER_ENTRY);
  if (existsSync(sourceEntry)) {
    return [TSX_CLI, sourceEntry];
  }
  return [join(ROOT, COMPILED_MANAGEMENT_JOB_RUNNER_ENTRY)];
}

function startManagementJobRunner(): ChildProcess | null {
  if (shuttingDown) return null;
  if (managementJobRunnerProcess) return managementJobRunnerProcess;
  const env = buildBridgeChildEnv(process.env, MANAGED_ENV_KEYS, BRIDGE_ENV_PATH, {
    BRIDGE_DATA_DIR: DATA_DIR,
    BRIDGE_DISTRIBUTION_MODE: DISTRIBUTION.mode,
    [BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV]: DISTRIBUTION.mode,
    [BRIDGE_CONTROL_ROOT_ENV]: ROOT,
    BRIDGE_LAUNCHER_LOG_PATH: LAUNCHER_LOG_PATH,
  });
  log("Starting management job runner...");
  const child = spawnLauncherChildIfRunning(
    () => shuttingDown,
    () => spawn(NODE_PATH, managementJobRunnerArgs(), {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      env,
      detached: shouldSpawnDetachedProcessGroup(),
    }),
  );
  if (!child) return null;
  trackChildProcessIdentity(child);
  managementJobRunnerProcess = child;
  child.on("exit", (code, signal) => {
    log(`Management job runner exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
    const wasActive = managementJobRunnerProcess === child;
    if (wasActive) {
      managementJobRunnerProcess = null;
    }
    if (wasActive && !shuttingDown) {
      setTimeout(() => {
        if (!shuttingDown && !managementJobRunnerProcess) startManagementJobRunner();
      }, CRASH_RESTART_DELAY);
    }
  });
  attachLauncherChildErrorHandler(child, {
    label: "Management job runner",
    log,
    onSpawnFailure: () => {
      if (managementJobRunnerProcess !== child) return;
      managementJobRunnerProcess = null;
      if (!shuttingDown) {
        setTimeout(() => {
          if (!shuttingDown && !managementJobRunnerProcess) startManagementJobRunner();
        }, CRASH_RESTART_DELAY);
      }
    },
  });
  return child;
}

function trackChildProcessIdentity(proc: ChildProcess): void {
  const identity = proc.pid
    ? captureProcessIdentity(proc.pid, createDeadline(CHILD_IDENTITY_CAPTURE_TIMEOUT_MS))
    : Promise.resolve(null);
  childProcessIdentities.set(proc, identity);
  void identity.then((captured) => {
    if (!captured && proc.exitCode === null && proc.signalCode === null) {
      log(`❌ Unable to capture creation identity for child PID ${proc.pid ?? "unknown"}`);
    }
  });
}

function asLauncherChild(label: string, child: ChildProcess | null): LauncherChild {
  return {
    label,
    process: child,
    identity: child ? childProcessIdentities.get(child) ?? null : null,
  };
}

async function shutdownAndExit(exitCode: number, reason: string): Promise<never> {
  if (!terminalShutdownPromise) {
    shuttingDown = true;
    log(`Shutting down launcher children (${reason})...`);
    const tunnelChildren = allTunnelSupervisors.map((supervisor) => supervisor.prepareForShutdown());
    terminalShutdownPromise = resolveLauncherShutdownExitCode(
      exitCode,
      () => [
        asLauncherChild("server", serverProcess),
        asLauncherChild("management job runner", managementJobRunnerProcess),
        ...tunnelChildren,
      ],
      {
        terminateProcessTree,
        waitForChildExit,
        log,
      },
      createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
    ).then(({ exitCode: resolvedExitCode, outcome }) => {
      for (const supervisor of allTunnelSupervisors) supervisor.finishShutdown(outcome.ok);
      if (!outcome.ok) {
        log(
          `❌ Terminal cleanup incomplete; exiting ${LAUNCHER_CLEANUP_FAILURE_EXIT_CODE} with descendants still active: ${outcome.remaining.join(", ")}`,
        );
      }
      return resolvedExitCode;
    });
  }

  process.exit(await terminalShutdownPromise);
}

async function forceKillServerAndWait(
  reason: string,
  deadline: Deadline = createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
): Promise<boolean> {
  const existingServer = serverProcess;
  if (!existingServer) {
    return true;
  }

  log(reason);
  const outcome = await stopLauncherChild(
    asLauncherChild("server", existingServer),
    { terminateProcessTree, waitForChildExit, log },
    { deadline },
  );
  if (outcome.ok && serverProcess === existingServer) {
    serverProcess = null;
    serverLaunchTarget = null;
  }
  return outcome.ok;
}

async function requestServerShutdown(deadline: Deadline, ifIdle: boolean): Promise<"stopping" | "busy"> {
  const controller = new AbortController();
  const requestTimeoutMs = Math.max(1, Math.min(GRACEFUL_SHUTDOWN_REQUEST_TIMEOUT, remainingMs(deadline)));
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(bridgeLocalUrl("/api/shutdown"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deadlineUnixMs: deadline.expiresAtUnixMs, ...(ifIdle ? { ifIdle: true } : {}) }),
      signal: controller.signal,
    });
    if (ifIdle && response.status === 409) return "busy";
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return "stopping";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stops the server for a restart. With `ifIdle` the server agrees only while nothing is in flight,
 * and checks that in the same step as it stops taking work, so the restart cannot cut off a run
 * that began after the launcher last looked. "busy" leaves everything as it was. `onStopping`
 * runs once the stop is certain.
 */
async function stopServerForRestart(
  ifIdle: boolean,
  onStopping: () => Promise<void>,
): Promise<"stopped" | "busy" | "failed"> {
  const existingServer = serverProcess;
  if (!existingServer) {
    await onStopping();
    return "stopped";
  }

  const deadline = createDeadline(GRACEFUL_EXIT_WAIT + PROCESS_TREE_TERMINATION_BUDGET_MS);
  const gracefulDeadline = deadlineBefore(deadline, PROCESS_TREE_TERMINATION_BUDGET_MS);
  let shutdownRequested = false;
  if (ifIdle) {
    try {
      if ((await requestServerShutdown(gracefulDeadline, true)) === "busy") return "busy";
      shutdownRequested = true;
    } catch (error) {
      log(`Server did not answer the shutdown request (${error instanceof Error ? error.message : String(error)})`);
      return "busy";
    }
  }
  await onStopping();
  const outcome = await stopLauncherChild(
    asLauncherChild("server", existingServer),
    { terminateProcessTree, waitForChildExit, log },
    {
      deadline,
      gracefulDeadline,
      requestGraceful: async (shutdownDeadline) => {
        if (shutdownRequested) return;
        log("Requesting graceful shutdown...");
        await requestServerShutdown(shutdownDeadline, false);
      },
    },
  );
  if (outcome.ok && serverProcess === existingServer) {
    serverProcess = null;
    serverLaunchTarget = null;
  }
  if (outcome.ok) {
    log(outcome.mode === "graceful" ? "Server exited cleanly" : "Server stop verified");
  }
  return outcome.ok ? "stopped" : "failed";
}

/** Takes the request out of its waiting place. Whatever joined it since it was first read comes along. */
function claimRestartSignal(): RestartSignal {
  const claim = consumeRestartSignalFile(SIGNAL_FILE, IN_PROGRESS_SIGNAL_FILE);
  if (claim.status === "claimed") {
    restartSignalClaimed = true;
    return claim.signal;
  }
  if (claim.status === "invalid") {
    rejectInvalidRestartSignal(claim);
    throw claim.error;
  }
  if (claim.status === "retryable-error") {
    throw new Error(`Failed to claim restart signal (${claim.stage})`, { cause: claim.error });
  }
  throw new Error("Restart request disappeared before cutover");
}

/**
 * Swaps the server. Called only while the Bridge is idle, or with `force`. Until the server has
 * agreed to stop nothing is changed, so "waiting" means the request simply stays pending.
 */
async function restart(signal: RestartSignal, force: boolean): Promise<RestartOutcome> {
  log(force ? "═══ Restarting ═══" : "═══ Bridge is idle — restarting ═══");
  const validationMode = signal.validationMode;
  clearReleaseFailureTracking();
  releaseCandidateSha = null;
  let candidateRelease = resolveReleaseCandidate(DATA_DIR, signal.releaseCandidate);
  const candidateOutcome = resolveReleaseCandidateRestartOutcome({
    releaseCandidateRequested: signal.releaseCandidate !== undefined,
    releaseCandidateResolved: candidateRelease !== null,
  });
  if (candidateOutcome) {
    const claimed = claimRestartSignal();
    if (JSON.stringify(claimed.releaseCandidate) !== JSON.stringify(signal.releaseCandidate)) {
      return "waiting";
    }
    if (signal.releaseCandidate) {
      markReleaseUpdateActivationRejected(
        signal.releaseCandidate.id,
        "Prepared release candidate metadata was invalid or missing; the current server was left running.",
      );
    }
    log("Restart signal referenced an invalid release candidate — leaving the current server running");
    return candidateOutcome;
  }
  const hadRunningServerAtStart = serverProcess !== null;
  const previousLaunchTarget = serverLaunchTarget ?? resolveStartupLaunchTarget();
  releaseCandidateSha = candidateRelease?.commitSha ?? normalizeGitHash(gitHash());
  const buildHeadSha = candidateRelease ? null : gitFullHash();

  if (candidateRelease) {
    log(`Using prepared release candidate ${candidateRelease.id} (${candidateRelease.commitSha.slice(0, 8)}) — skipping production-root build`);
  } else if (!build(validationMode)) {
    const latest = readCurrentRestartSignalFile(SIGNAL_FILE, IN_PROGRESS_SIGNAL_FILE);
    if (!buildHeadSha || gitFullHash() !== buildHeadSha || latest?.releaseCandidate
      || (!force && !(await isBridgeIdle()))) {
      log("Restart preparation failed while work or the checkout changed — leaving it untouched and retrying later");
      return "waiting";
    }
    if (claimRestartSignal().releaseCandidate) return "waiting";
    log("Build failed — rolling back");
    await notifyWebhook(`⚠️ Build failed — rolling back to last checkpoint (${tag()})`, tunnelSupervisor.getUrl());
    const rollbackSucceeded = rollback();
    if (!rollbackSucceeded) {
      log("Rollback did not complete successfully");
      enterStoppedStateAfterFailedRollback();
      await recordFailureAndMaybeStop("rollback", {
        manualInterventionMessage: "Rollback failed after build validation failure — manual intervention required.",
        retryReason: "rollback failure after build validation failure",
      });
      return "failed";
    }

    let rolledBackServerHealthy = false;
    if (rollbackRecoveryRequiresServerStart({ hadRunningServerAtStart })) {
      const rolledBackServer = startServer();
      if (!rolledBackServer) return "failed";
      serverProcess = rolledBackServer;
      rolledBackServerHealthy = await healthCheck(rolledBackServer);
      if (shuttingDown) return "failed";
      if (!rolledBackServerHealthy) {
        log("❌ Rolled-back server failed health check");
        await forceKillServerAndWait("Stopping failed rolled-back server...");
        enterStoppedStateAfterFailedRollback();
      }
    }

    const outcome = resolveRollbackRecoveryOutcome({
      rollbackSucceeded,
      hadRunningServerAtStart,
      rolledBackServerHealthy,
    });
    if (outcome === "failed") {
      await recordFailureAndMaybeStop("rollback", {
        manualInterventionMessage: "Rolled-back server failed health checks after build validation failure — manual intervention required.",
        retryReason: "rolled-back server health check failure after build validation failure",
      });
      return "failed";
    }
    consecutiveFailures = 0;
    startManagementJobRunner();
    if (shuttingDown) return "failed";
    log("✅ Recovery completed via rollback");
    return "recovered-via-rollback";
  }

  if (shuttingDown) return "failed";

  const stop = await stopServerForRestart(!force, async () => {
    restarting = true;
    const claimed = claimRestartSignal();
    await safeWriteRestartState({ phase: "restarting", releaseFailure: null });
    if (!claimed.releaseCandidate || claimed.releaseCandidate.id === signal.releaseCandidate?.id) return;
    const newerRelease = resolveReleaseCandidate(DATA_DIR, claimed.releaseCandidate);
    if (newerRelease) {
      candidateRelease = newerRelease;
      releaseCandidateSha = newerRelease.commitSha;
      log(`Restart picked up newer release ${newerRelease.id} (${newerRelease.commitSha.slice(0, 8)})`);
    } else {
      markReleaseUpdateActivationRejected(
        claimed.releaseCandidate.id,
        "Prepared release candidate metadata was invalid or missing; it was not activated.",
      );
      throw new Error(`Updated release candidate ${claimed.releaseCandidate.id} is invalid`);
    }
  });
  if (stop === "busy") {
    log("Work arrived before the server stopped — the restart keeps waiting");
    return "waiting";
  }
  if (shuttingDown) return "failed";

  const replacementTransition = await startAfterVerifiedStop(
    async () => stop === "stopped",
    () => startServer(candidateRelease ? releaseLaunchTarget(candidateRelease) : resolveStartupLaunchTarget()),
  );
  if (shuttingDown) return "failed";
  if (!replacementTransition.stopped) {
    log("❌ Existing server did not exit after force kill — aborting restart");
    if (candidateRelease) {
      markReleaseUpdateActivationRejected(
        candidateRelease.id,
        "The launcher could not stop the current server to activate the staged update.",
      );
    }
    await recordFailureAndMaybeStop("shutdown", {
      retryReason: "server shutdown failure during restart",
    });
    return "failed";
  }
  const replacementServer = replacementTransition.replacement;
  if (!replacementServer) return "failed";
  serverProcess = replacementServer;

  const healthy = await healthCheck(replacementServer);
  if (shuttingDown) return "failed";
  if (healthy) {
    if (candidateRelease) await writeActiveRelease(DATA_DIR, candidateRelease);
    // The restart is over for everyone watching it; what follows is the launcher's own housekeeping.
    clearInProgressSignal();
    await safeClearRestartState();
    if (candidateRelease) {
      markReleaseUpdateActivationSucceeded(candidateRelease.id);
      const pruned = pruneReleaseSlots(DATA_DIR, {
        extraKeepIds: [previousLaunchTarget.release?.id],
        log,
      });
      if (pruned > 0) {
        log(`Pruned ${pruned} stale release slot artifact(s)`);
      }
      startManagementJobRunner();
      syncProductionRootDepsAfterReleaseActivation();
    } else {
      startManagementJobRunner();
    }
    log("✅ Server restarted successfully");
    consecutiveFailures = 0;
    await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, tunnelSupervisor.getUrl());
    return "restarted";
  } else {
    log("❌ Health check failed — rolling back");
    if (candidateRelease) {
      markReleaseUpdateActivationFailed(
        candidateRelease.id,
        "The staged update failed health checks during activation; the previous launch target is being restored.",
      );
    }
    await notifyWebhook(
      candidateRelease
        ? `⚠️ Health check failed — restoring previous launch target (${tag()})`
        : `⚠️ Health check failed — rolling back to last checkpoint (${tag()})`,
      tunnelSupervisor.getUrl(),
    );
    const stoppedAfterFailure = await forceKillServerAndWait("Stopping failed restart before rollback...");
    if (!stoppedAfterFailure) {
      await recordFailureAndMaybeStop("shutdown", {
        retryReason: "failed restart shutdown failure before rollback",
      });
      return "failed";
    }
    if (candidateRelease && (previousLaunchTarget.release || DISTRIBUTION.mode === "release")) {
      log(`Restoring previous launch target after failed candidate ${candidateRelease.id}`);
      const fallbackServer = startServer(previousLaunchTarget);
      if (!fallbackServer) return "failed";
      serverProcess = fallbackServer;
      const fallbackHealthy = await healthCheck(fallbackServer);
      if (shuttingDown) return "failed";
      if (!fallbackHealthy) {
        log("❌ Previous server failed health check after candidate failure");
        await forceKillServerAndWait("Stopping failed previous server...");
        await recordFailureAndMaybeStop("restart-health-check", {
          manualInterventionMessage: "Prepared release candidate failed health checks, and the previous server could not be restored — manual intervention required.",
          retryReason: "previous server health check failure after candidate failure",
        });
        return "failed";
      }
      consecutiveFailures = 0;
      startManagementJobRunner();
      if (shuttingDown) return "failed";
      log("✅ Previous server restored after failed release candidate");
      return "recovered-via-rollback";
    }
    const rollbackSucceeded = rollback();
    if (!rollbackSucceeded) {
      log("❌ Rollback failed — leaving server stopped");
      enterStoppedStateAfterFailedRollback();
      await recordFailureAndMaybeStop("rollback", {
        manualInterventionMessage: "Rollback failed after restart health check failure — manual intervention required.",
        retryReason: "rollback failure after restart health check failure",
      });
      return "failed";
    }
    const rolledBackServer = startServer();
    if (!rolledBackServer) return "failed";
    serverProcess = rolledBackServer;
    const rolledBackServerHealthy = await healthCheck(rolledBackServer);
    if (shuttingDown) return "failed";
    const outcome = resolveRollbackRecoveryOutcome({
      rollbackSucceeded,
      hadRunningServerAtStart,
      rolledBackServerHealthy,
    });
    if (outcome === "failed") {
      log("❌ Rolled-back server failed health check");
      await forceKillServerAndWait("Stopping failed rolled-back server...");
      enterStoppedStateAfterFailedRollback();
      await recordFailureAndMaybeStop("rollback", {
        manualInterventionMessage: "Rolled-back server failed health checks — manual intervention required.",
        retryReason: "rolled-back server health check failure",
      });
      return "failed";
    }
    consecutiveFailures = 0;
    startManagementJobRunner();
    if (shuttingDown) return "failed";
    log("✅ Recovery completed via rollback");
    return "recovered-via-rollback";
  }
}

// ── Webhook Notification ──────────────────────────────────────────

async function notifyWebhook(message: string, url?: string): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, url }),
      // Recovery paths await this; an unresponsive endpoint must not hold them open.
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (res.ok) {
      log("Webhook notification sent");
    } else {
      log(`Webhook notification failed: ${res.status}`);
    }
  } catch (err) {
    log(`Webhook notification error: ${err}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  process.env.BRIDGE_LAUNCHER_LOG_PATH = LAUNCHER_LOG_PATH;
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Bridge Launcher           ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  restorePendingRestartSignal();
  const previousRestartState = await readRestartState(RESTART_STATE_FILE);
  if (previousRestartState.phase === "restarting") {
    await safeWriteRestartState({ phase: "idle", releaseFailure: previousRestartState.releaseFailure });
  }

  const sweptRestartTemps = sweepStaleRestartStateTempFiles(RESTART_STATE_FILE);
  if (sweptRestartTemps > 0) {
    log(`Swept ${sweptRestartTemps} stale restart-state temp file(s) from previous run`);
  }

  const startupDecision = decideLauncherStartup({
    restartSignalPresent: existsSync(SIGNAL_FILE),
    autoRecoverySuppressed: suppressAutoRecovery,
  });
  if (startupDecision.clearRestartSignal) {
    clearSignal();
  } else {
    log(startupDecision.logMessage);
  }

  for (const warning of tunnelConfig.warnings) log(`[tunnel] ${warning}`);
  log(tunnelConfig.tunnels.length > 0
    ? `[tunnel] Hosting ${tunnelConfig.tunnels.map((tunnel) => tunnel.auth === "github" ? `github:${tunnel.name}` : tunnel.name).join(", ")}`
    : "[tunnel] No tunnel configured (BRIDGE_TUNNEL_NAMES is empty)");
  for (const supervisor of allTunnelSupervisors) await supervisor.start();
  if (shuttingDown) return;

  if (startupDecision.startServer) {
    if (
      DISTRIBUTION.mode === "development"
      && DISTRIBUTION.gitAvailable
      && shouldPullOnLauncherStartup(process.env)
    ) {
      const currentBranch = run("git rev-parse --abbrev-ref HEAD");
      const branchName = currentBranch.ok ? currentBranch.output.trim() : "main";
      const pullCommand = createGitPullRebaseCommand(branchName);
      const pullResult = run(pullCommand.displayCommand, {
        executable: pullCommand.command,
        args: pullCommand.args,
      });
      if (pullResult.ok) {
        log("Pulled latest from origin");
      } else {
        log(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
      }
    } else if (DISTRIBUTION.mode === "development" && DISTRIBUTION.gitAvailable) {
      log(`Startup git pull disabled; set ${LAUNCHER_STARTUP_GIT_PULL_ENV}=true to enable it`);
    } else {
      log(`${DISTRIBUTION.mode} mode - skipping startup git pull`);
    }

    // Ensure dependencies are in sync after pull
    const swept = sweepStalePatchPackageBackups(ROOT);
    if (swept.length > 0) {
      log(`Swept ${swept.length} stale patch-package backup dir(s) from previous run`);
    }
    if (!verifyLauncherStartup({ ensureDeps, log })) {
      throw new Error("Dependency sync failed during startup");
    }

    const pruned = pruneReleaseSlots(DATA_DIR, { log });
    if (pruned > 0) {
      log(`Pruned ${pruned} stale release slot artifact(s) during startup`);
    }

    // Start server
    const startupServer = startServer();
    if (!startupServer) return;
    serverProcess = startupServer;
    await notifyWebhook(`🤖 Copilot Bridge is online! (${tag()})`, tunnelSupervisor.getUrl());
  }

  if (startupDecision.startServer && !shuttingDown) {
    startManagementJobRunner();
  }

  if (shuttingDown) return;

  // A pending restart is looked at on every poll until the Bridge is idle enough to act on it.
  setInterval(() => {
    if (restartCheckInFlight || restarting || recoveringServer
      || (!existsSync(SIGNAL_FILE) && !existsSync(IN_PROGRESS_SIGNAL_FILE))) return;
    processRestartSignal().catch((error) => {
      log(`Restart attempt failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
  }, POLL_INTERVAL);

  setInterval(() => {
    void pollServerHealth();
  }, HEALTH_POLL_INTERVAL);

  log("Watching for restart signals...");
}

process.on("SIGINT", () => {
  void shutdownAndExit(0, "SIGINT");
});

process.on("SIGTERM", () => {
  void shutdownAndExit(0, "SIGTERM");
});

main().catch((err) => {
  const fatalMessage = `[launcher] Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  appendLauncherLogLine(fatalMessage);
  console.error(fatalMessage);
  void shutdownAndExit(1, "fatal launcher error");
});
