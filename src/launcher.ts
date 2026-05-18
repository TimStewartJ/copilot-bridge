// Launcher — immortal parent process that manages the bridge server

import "./log-timestamps.js";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencySyncHash, preparePatchedPackagesForInstall, sweepStalePatchPackageBackups } from "./server/dependency-sync.js";
import { buildBridgeChildEnv, loadBridgeEnvManagedKeys } from "./server/env-loader.js";
import { appendLauncherLogLine, getLauncherLogPath } from "./server/launcher-log.js";
import {
  killProcessTree as platformKillTree,
  shouldSpawnDetachedProcessGroup,
  waitForProcessTreeExit,
  type ProcessTreeKillResult,
} from "./server/platform.js";
import { resolveBridgePort } from "./server/port-config.js";
import { clearRollbackCheckpoint } from "./server/pre-deploy-checkpoint.js";
import { waitForIdleSessions as waitForIdleSessionsImpl } from "./server/restart-coordinator.js";
import { runSyncCommand } from "./server/sync-command-runner.js";
import { createValidationCommandEnv, prependNodePath } from "./server/validation-command-env.js";
import { readDeployValidationStamp, validateDeployValidationStamp } from "./server/deploy-validation-stamp.js";
import { consumeRestartSignalFile, type RestartSignal, type RestartValidationMode } from "./server/restart-signal.js";
import {
  buildRestartStateWithReleaseFailure,
  clearRestartState,
  readRestartState,
  type ReleaseFailurePhase,
  type ReleaseFailureState,
  writeRestartState,
} from "./server/restart-state.js";
import { canUseDevtunnelCli, getDevtunnelCliStatus, resolveBridgeTunnelName } from "./server/tunnel.js";
import { resolveBridgeDistribution } from "./server/distribution-mode.js";
import { resolveRuntimePaths } from "./server/runtime-paths.js";
import {
  clearPersistentRollbackFailureState,
  hasPersistentRollbackFailureState,
  markPersistentRollbackFailureState,
} from "./launcher-rollback-state.js";
import {
  buildRestartingState,
  buildRestartingWaitingState,
  buildWaitingState,
  type RestartPickupInfo,
} from "./launcher-restart-state-ops.js";
import {
  didRestartRecover,
  resolveRollbackRecoveryOutcome,
  rollbackRecoveryRequiresServerStart,
  type RestartOutcome,
} from "./launcher-restart.js";
import {
  evaluateHealthPoll,
  evaluatePostRecoveryState,
  evaluateUnexpectedExit,
  shouldIgnoreHealthPollResult,
} from "./launcher-health.js";
import { runLauncherBuild, runLauncherRollbackWithCheckpointHandling, verifyLauncherStartup } from "./launcher-build.js";
import type { LauncherCommandOptions } from "./launcher-build.js";
import { DEPLOY_CHECK_COMMAND, DEPLOY_GATE, DEPLOY_GATE_VERSION } from "./server/validation-pipeline.js";
import {
  decideLauncherStartup,
  decideRecoveryExecution,
  shouldCheckFollowUpRecovery,
  shouldClearRollbackCheckpointAfterHealthyState,
} from "./launcher-recovery.js";
import { isChildProcessActive } from "./launcher-process.js";
import { withNonInteractiveCommandEnv } from "./server/noninteractive-env.js";

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
const SOURCE_SERVER_ENTRY = join(ROOT, "src", "server", "index.ts");
const COMPILED_SERVER_ENTRY = join(ROOT, "dist", "server", "index.js");
const SERVER_ENTRY = DISTRIBUTION.mode === "release" ? COMPILED_SERVER_ENTRY : SOURCE_SERVER_ENTRY;
if (!process.env.BRIDGE_LAUNCHER_LOG_PATH) {
  process.env.BRIDGE_LAUNCHER_LOG_PATH = join(DATA_DIR, "launcher.log");
}
const LAUNCHER_LOG_PATH = getLauncherLogPath();
const MAX_FAILURES = 3;
const POLL_INTERVAL = 2_000;
const HEALTH_TIMEOUT = 120_000;
const HEALTH_POLL_INTERVAL = 30_000;
const HEALTH_POLL_TIMEOUT = 5_000;
const HEALTH_FAILURE_THRESHOLD = 3;

// Notification config
const TUNNEL_NAME = resolveBridgeTunnelName(process.env);
const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL || "";

const BUSY_CHECK_INTERVAL = 3_000;
const BUSY_WAIT_TIMEOUT = 3_600_000; // 60 minutes max wait
const STALE_THRESHOLD = 300_000; // 5 minutes — session with no events is "stuck"
const GRACEFUL_EXIT_WAIT = 15_000; // wait for clean exit after POST /api/shutdown
const GRACEFUL_SHUTDOWN_REQUEST_TIMEOUT = 5_000; // bound shutdown POST so force-kill fallback is reachable
const FORCED_EXIT_WAIT = 5_000; // wait for SIGKILLed child to actually exit before restarting
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

// Tunnel resilience config
const MAX_TUNNEL_RESTARTS = 5;
const TUNNEL_CRASH_WINDOW = 300_000; // reset crash counter after 5 min of stability
const TUNNEL_BACKOFF_BASE = 5_000; // 5s initial backoff
const TUNNEL_BACKOFF_CAP = 60_000; // 60s max backoff

let serverProcess: ChildProcess | null = null;
let tunnelProcess: ChildProcess | null = null;
let currentTunnelUrl: string | null = null;
let consecutiveFailures = 0;
let restarting = false;
let shuttingDown = false;
let crashRestarts = 0;
let lastCrashTime = 0;
let tunnelCrashRestarts = 0;
let tunnelStartedAt = 0;
let steadyHealthFailures = 0;
let healthPollInFlight = false;
let recoveringServer = false;
let tunnelStatusLogged = false;
let suppressAutoRecovery = hasPersistentRollbackFailureState(FAILED_ROLLBACK_STATE_FILE);
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

type HealthProbeResult = {
  healthy: boolean;
  failureDetail?: string;
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

function gitHash(): string {
  try {
    return execSync("git --no-pager rev-parse --short HEAD", {
      cwd: ROOT,
      encoding: "utf-8",
      env: commandEnv(),
      timeout: 5_000,
    }).trim();
  } catch { return "unknown"; }
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

function clearStaleInProgressSignal() {
  if (!existsSync(SIGNAL_FILE) && existsSync(IN_PROGRESS_SIGNAL_FILE)) {
    log("Discarding stale in-progress restart signal from a previous launcher run");
    clearInProgressSignal();
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

function run(cmd: string, options: LauncherCommandOptions = {}): { ok: boolean; output: string } {
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
      command: cmd,
      cwd: ROOT,
      env,
      timeoutMs,
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

const DEPS_HASH_FILE = join(DATA_DIR, "deps-hash");

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
  const result = run("npm install --no-audit --no-fund --include=dev");
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
  suppressAutoRecovery = true;
  markPersistentRollbackFailureState(FAILED_ROLLBACK_STATE_FILE);
}

function clearFailedRollbackState() {
  suppressAutoRecovery = false;
  clearPersistentRollbackFailureState(FAILED_ROLLBACK_STATE_FILE);
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

/** Read existing queued state to preserve requestId / requestedAt for continuity. */
async function readRestartPickupInfo(): Promise<RestartPickupInfo> {
  const state = await readRestartState(RESTART_STATE_FILE);
  return { requestId: state.requestId, requestedAt: state.requestedAt };
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
    const state = await readRestartState(RESTART_STATE_FILE);
    await writeRestartState(
      RESTART_STATE_FILE,
      buildRestartStateWithReleaseFailure(state, pendingReleaseFailure),
    );
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
  await notifyWebhook(`❌ ${formatReleaseFailureMessage(failure, { includeTag: true })}`, currentTunnelUrl ?? undefined);
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
  await notifyWebhook(`❌ ${formatReleaseFailureMessage(failure, { includeTag: true })}`, currentTunnelUrl ?? undefined);
  process.exit(1);
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

async function processRestartSignal(): Promise<void> {
  if (restarting || shuttingDown) return;
  restarting = true;
  let restartOutcome: RestartOutcome = "failed";
  let consumedSignal = false;
  try {
    let signal: RestartSignal | null;
    try {
      signal = consumeRestartSignalFile(SIGNAL_FILE, IN_PROGRESS_SIGNAL_FILE);
    } catch (err) {
      log(`Failed to claim restart signal (will retry): ${err}`);
      return;
    }
    if (!signal) return;
    consumedSignal = true;
    restartOutcome = await restart(signal.validationMode);
  } finally {
    if (consumedSignal) {
      clearInProgressSignal();
      if (restartOutcome === "failed" && pendingReleaseFailure) {
        await safePersistPendingReleaseFailure();
      } else {
        await safeClearRestartState();
      }
    }
    restarting = false;
    if (consumedSignal) {
      if (didRestartRecover(restartOutcome)) {
        clearFailedRollbackState();
        clearRollbackCheckpointAfterHealthyState();
      }
      if (!shouldCheckFollowUpRecovery({ autoRecoverySuppressed: suppressAutoRecovery })) {
        return;
      }
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
    if (res.ok) return { healthy: true };
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
    void processRestartSignal();
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
      serverProcess = replacementServer;
      const healthy = await healthCheck(replacementServer);
      if (healthy) {
        steadyHealthFailures = 0;
        clearRollbackCheckpointAfterHealthyState();
        log(`✅ Auto-restart succeeded after ${reason}`);
        await notifyWebhook(
          `⚡ Copilot Bridge auto-restarted after ${reason} (attempt ${attempt}/${MAX_CRASH_RESTARTS}, ${tag()})`,
          currentTunnelUrl ?? undefined,
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
      healthResult = await probeServerHealth(HEALTH_POLL_TIMEOUT);
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
      clearRollbackCheckpointAfterHealthyState();
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

function shouldUseDevtunnel(): boolean {
  const status = getDevtunnelCliStatus();
  if (status.enabled && status.available) return true;
  if (!tunnelStatusLogged) {
    log(`[tunnel] ${status.reason ?? "Dev tunnel unavailable"}`);
    tunnelStatusLogged = true;
  }
  return false;
}

function startServer(): ChildProcess {
  const env = buildBridgeChildEnv(process.env, MANAGED_ENV_KEYS, BRIDGE_ENV_PATH, { BRIDGE_DATA_DIR: DATA_DIR });
  const port = resolveBridgePort(env);
  currentServerPort = port;
  log(`Starting server on port ${port}...`);
  env.BRIDGE_LAUNCHER_LOG_PATH = LAUNCHER_LOG_PATH;
  if (currentTunnelUrl) env.BRIDGE_TUNNEL_URL = currentTunnelUrl;
  const serverArgs = SERVER_ENTRY.endsWith(".ts") ? [TSX_CLI, SERVER_ENTRY] : [SERVER_ENTRY];
  const child = spawn(NODE_PATH, serverArgs, {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env,
    detached: shouldSpawnDetachedProcessGroup(),
  });
  steadyHealthFailures = 0;

  child.on("exit", (code, signal) => {
    log(`Server exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
    if (serverProcess === child) {
      serverProcess = null;
    }

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

  return child;
}

function killProcessTree(proc: ChildProcess | null): ProcessTreeKillResult | null {
  if (!proc || !proc.pid) return null;
  return platformKillTree(proc.pid);
}

function killServer() {
  if (serverProcess) {
    log("Stopping server...");
    killProcessTree(serverProcess);
    serverProcess = null;
  }
}

async function forceKillServerAndWait(reason: string, timeoutMs = FORCED_EXIT_WAIT): Promise<boolean> {
  const existingServer = serverProcess;
  if (!existingServer) {
    return true;
  }

  log(reason);
  const killResult = killProcessTree(existingServer);
  if (!killResult) {
    log("❌ Server process did not have a PID for force kill");
    return false;
  }

  const exited = await waitForProcessTreeExit(killResult, timeoutMs);
  if (!exited) {
    log(`❌ Server process tree did not exit within ${timeoutMs}ms after force kill`);
  } else if (serverProcess === existingServer) {
    serverProcess = null;
  }
  return exited;
}

async function waitForIdleSessions(onWaiting?: (count: number) => void | Promise<void>): Promise<boolean> {
  const busyUrl = bridgeLocalUrl("/api/busy");
  return waitForIdleSessionsImpl({
    fetchBusy: async () => {
      const res = await fetch(busyUrl);
      if (!res.ok) throw new Error(`Busy check failed: ${res.status}`);
      return await res.json() as any;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    isServerAlive: () => serverProcess !== null,
    busyCheckInterval: BUSY_CHECK_INTERVAL,
    busyWaitTimeout: BUSY_WAIT_TIMEOUT,
    staleThreshold: STALE_THRESHOLD,
    onWaiting,
  });
}

async function gracefulStopServer(): Promise<boolean> {
  const shutdownUrl = bridgeLocalUrl("/api/shutdown");
  try {
    log("Requesting graceful shutdown...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GRACEFUL_SHUTDOWN_REQUEST_TIMEOUT);
    try {
      await fetch(shutdownUrl, { method: "POST", signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    log("Server not reachable or did not respond for graceful shutdown — falling back to force kill");
    return await forceKillServerAndWait("Stopping unreachable server...");
  }

  // Wait for process to exit on its own
  const start = Date.now();
  while (serverProcess && Date.now() - start < GRACEFUL_EXIT_WAIT) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (serverProcess) {
    return await forceKillServerAndWait("Server did not exit in time — force killing");
  } else {
    log("Server exited cleanly");
  }
  return true;
}

async function restart(validationMode: RestartValidationMode): Promise<RestartOutcome> {
  log("═══ Restart requested ═══");
  const hadRunningServerAtStart = serverProcess !== null;
  pendingReleaseFailure = null;
  lastCommandFailure = null;
  lastRollbackTarget = null;
  releaseCandidateSha = normalizeGitHash(gitHash());

  // Preserve requestId / requestedAt from the queued state written by the server.
  const pickupInfo = await readRestartPickupInfo();

  // Transition: queued → waiting-for-sessions
  await safeWriteRestartState(buildWaitingState(pickupInfo, 0, new Date().toISOString()));

  // First session wait — refresh waitingSessions + launcherHeartbeatAt on every busy check.
  await waitForIdleSessions(async (count) => {
    await safeWriteRestartState(buildWaitingState(pickupInfo, count, new Date().toISOString()));
  });

  // Transition: waiting-for-sessions → restarting (build / shutdown / swap begins now)
  await safeWriteRestartState(buildRestartingState(pickupInfo, new Date().toISOString()));

  if (!build(validationMode)) {
    log("Build failed — rolling back");
    await notifyWebhook(`⚠️ Build failed — rolling back to last checkpoint (${tag()})`, currentTunnelUrl ?? undefined);
    const rollbackSucceeded = rollback();
    if (!rollbackSucceeded) {
      log("Rollback did not complete successfully");
      enterStoppedStateAfterFailedRollback();
      try { await fetch(bridgeLocalUrl("/api/restart-clear"), { method: "POST" }); }
      catch { /* server may be unreachable */ }
      await recordFailureAndMaybeStop("rollback", {
        manualInterventionMessage: "Rollback failed after build validation failure — manual intervention required.",
        retryReason: "rollback failure after build validation failure",
      });
      return "failed";
    }

    let rolledBackServerHealthy = false;
    if (rollbackRecoveryRequiresServerStart({ hadRunningServerAtStart })) {
      const rolledBackServer = startServer();
      serverProcess = rolledBackServer;
      rolledBackServerHealthy = await healthCheck(rolledBackServer);
      if (!rolledBackServerHealthy) {
        log("❌ Rolled-back server failed health check");
        await forceKillServerAndWait("Stopping failed rolled-back server...");
        enterStoppedStateAfterFailedRollback();
      }
    }

    // Old server is still running with restart banner — dismiss it immediately
    try { await fetch(bridgeLocalUrl("/api/restart-clear"), { method: "POST" }); }
    catch { /* server may be unreachable */ }

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
    await ensureTunnelAfterRollback();
    log("✅ Recovery completed via rollback");
    return "recovered-via-rollback";
  }

  // Second session wait (new sessions that started during the build) — still in "restarting".
  await waitForIdleSessions(async (count) => {
    await safeWriteRestartState(buildRestartingWaitingState(pickupInfo, count, new Date().toISOString()));
  });

  const stopped = await gracefulStopServer();
  if (!stopped) {
    log("❌ Existing server did not exit after force kill — aborting restart");
    await recordFailureAndMaybeStop("shutdown", {
      retryReason: "server shutdown failure during restart",
    });
    return "failed";
  }
  const replacementServer = startServer();
  serverProcess = replacementServer;

  const healthy = await healthCheck(replacementServer);
  if (healthy) {
    log("✅ Server restarted successfully");
    consecutiveFailures = 0;

    // Cycle the tunnel so it gets a fresh connection
    if (shouldUseDevtunnel()) {
      try {
        tunnelCrashRestarts = 0; // reset since this is intentional
        const url = await startTunnel();
        await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, url);
      } catch (err) {
        log(`Tunnel restart failed (non-fatal): ${err}`);
        await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, currentTunnelUrl ?? undefined);
      }
    } else {
      await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, currentTunnelUrl ?? undefined);
    }
    return "restarted";
  } else {
    log("❌ Health check failed — rolling back");
    await notifyWebhook(`⚠️ Health check failed — rolling back to last checkpoint (${tag()})`, currentTunnelUrl ?? undefined);
    const stoppedAfterFailure = await forceKillServerAndWait("Stopping failed restart before rollback...");
    if (!stoppedAfterFailure) {
      await recordFailureAndMaybeStop("shutdown", {
        retryReason: "failed restart shutdown failure before rollback",
      });
      return "failed";
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
    serverProcess = rolledBackServer;
    const rolledBackServerHealthy = await healthCheck(rolledBackServer);
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
    await ensureTunnelAfterRollback();
    log("✅ Recovery completed via rollback");
    return "recovered-via-rollback";
  }
}

// ── Dev Tunnel ────────────────────────────────────────────────────

async function ensureTunnelAfterRollback(): Promise<void> {
  if (!shouldUseDevtunnel()) return;
  // Start (or cycle) the tunnel so rollback-recovered servers stay reachable.
  // Mirrors the tunnel cycle in the successful-restart branch.
  try {
    tunnelCrashRestarts = 0;
    const url = await startTunnel();
    log(`Tunnel restored after rollback: ${url}`);
  } catch (err) {
    log(`Tunnel restart after rollback failed (non-fatal): ${err}`);
  }
}

function startTunnel(): Promise<string> {
  if (!canUseDevtunnelCli()) {
    const status = getDevtunnelCliStatus();
    return Promise.reject(new Error(status.reason ?? "Dev tunnel unavailable"));
  }

  // Kill any existing tunnel first (idempotent)
  killTunnel();

  return new Promise((resolve, reject) => {
    const port = currentServerPort;
    log(`Starting dev tunnel for local port ${port}...`);
    tunnelProcess = spawn("devtunnel", ["host", TUNNEL_NAME], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      reject(new Error("Tunnel failed to start within 30s"));
    }, 30_000);

    tunnelProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log(`[tunnel] ${line}`);
    });

    tunnelProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      const match = stdout.match(/Connect via browser:\s+(https:\/\/\S+)/)
        ?? stdout.match(/Hosting port \d+ at\s+(https:\/\/\S+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        currentTunnelUrl = match[1];
        tunnelStartedAt = Date.now();
        log(`Tunnel URL: ${currentTunnelUrl}`);
        resolve(currentTunnelUrl);
      }
    });

    tunnelProcess.on("exit", (code) => {
      log(`Tunnel exited with code ${code}`);
      tunnelProcess = null;

      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`Tunnel process exited with code ${code} before producing URL`));
        return;
      }

      // Auto-respawn on unexpected exit
      if (shuttingDown || restarting) return;

      const now = Date.now();
      const uptime = now - tunnelStartedAt;
      if (uptime > TUNNEL_CRASH_WINDOW) {
        tunnelCrashRestarts = 0; // stable long enough, reset counter
      }
      tunnelCrashRestarts++;

      if (tunnelCrashRestarts > MAX_TUNNEL_RESTARTS) {
        log(`❌ Tunnel crashed ${tunnelCrashRestarts} times in quick succession — not restarting. Manual intervention needed.`);
        return;
      }

      const backoff = Math.min(TUNNEL_BACKOFF_BASE * Math.pow(2, tunnelCrashRestarts - 1), TUNNEL_BACKOFF_CAP);
      log(`⚡ Tunnel crashed (exit code ${code}). Auto-restarting in ${backoff / 1000}s... (attempt ${tunnelCrashRestarts}/${MAX_TUNNEL_RESTARTS})`);

      setTimeout(async () => {
        if (tunnelProcess || shuttingDown) return; // something else already started it
        try {
          const url = await startTunnel();
          log(`✅ Tunnel auto-restarted successfully`);
          await notifyWebhook(`⚡ Tunnel auto-restarted (attempt ${tunnelCrashRestarts}/${MAX_TUNNEL_RESTARTS}, ${tag()})`, url);
        } catch (err) {
          log(`❌ Tunnel auto-restart failed: ${err}`);
        }
      }, backoff);
    });
  });
}

function killTunnel() {
  if (tunnelProcess) {
    log("Stopping tunnel...");
    killProcessTree(tunnelProcess);
    tunnelProcess = null;
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

  clearStaleInProgressSignal();

  const startupDecision = decideLauncherStartup({
    restartSignalPresent: existsSync(SIGNAL_FILE),
    autoRecoverySuppressed: suppressAutoRecovery,
  });
  if (startupDecision.clearRestartSignal) {
    clearSignal();
  } else {
    log(startupDecision.logMessage);
  }

  if (startupDecision.startServer) {
    if (DISTRIBUTION.mode === "development" && DISTRIBUTION.gitAvailable) {
      // Pull latest from origin on startup
      const currentBranch = run("git rev-parse --abbrev-ref HEAD");
      const branchName = currentBranch.ok ? currentBranch.output.trim() : "main";
      const pullResult = run(`git pull --rebase origin ${branchName}`);
      if (pullResult.ok) {
        log("Pulled latest from origin");
      } else {
        log(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
      }
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

    // Start server
    serverProcess = startServer();

    // Start dev tunnel
    if (shouldUseDevtunnel()) {
      try {
        const url = await startTunnel();
        await notifyWebhook(`🤖 Copilot Bridge is online! (${tag()})`, url);
      } catch (err) {
        log(`Tunnel/notification setup failed (non-fatal): ${err}`);
      }
    }
  }

  // Poll for restart signal
  setInterval(async () => {
    if (!restarting && !recoveringServer && existsSync(SIGNAL_FILE)) {
      await processRestartSignal();
    }
  }, POLL_INTERVAL);

  setInterval(() => {
    void pollServerHealth();
  }, HEALTH_POLL_INTERVAL);

  log("Watching for restart signals...");
}

process.on("SIGINT", () => {
  log("Shutting down...");
  shuttingDown = true;
  killServer();
  killTunnel();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  killServer();
  killTunnel();
  process.exit(0);
});

main().catch((err) => {
  const fatalMessage = `[launcher] Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  appendLauncherLogLine(fatalMessage);
  console.error(fatalMessage);
  process.exit(1);
});
