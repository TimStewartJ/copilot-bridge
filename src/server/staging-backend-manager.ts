import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type express from "express";
import type { RequestHandler } from "express";
import { createSettingsStore } from "./settings-store.js";
import { clearRestartPending, triggerRestartPending } from "./session-manager.js";
import { writeRestartSignalFile, type RestartReleaseCandidate, type RestartValidationMode } from "./restart-signal.js";
import {
  captureProcessIdentity,
  PROCESS_TREE_TERMINATION_BUDGET_MS,
  shouldSpawnDetachedProcessGroup,
  terminateProcessTree,
  type ProcessIdentity,
} from "./platform.js";
import {
  createDeadline,
  remainingMs,
  settleByDeadline,
} from "./deadline.js";
import { BRIDGE_CONTROL_ROOT_ENV } from "./control-root.js";
import {
  BRIDGE_ACTIVE_RELEASE_ROOT_ENV,
  BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV,
} from "./distribution-mode.js";
import { prependNodePath } from "./validation-command-env.js";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths.js";
import {
  PRODUCTION_DATA_DIR,
  STAGING_BACKEND_FAILURE_BACKOFF_BASE_MS,
  STAGING_BACKEND_FAILURE_BACKOFF_MAX_MS,
  STAGING_BACKEND_IDLE_REAPER_INTERVAL_MS,
  STAGING_BACKEND_IDLE_TTL_MS,
  STAGING_BACKEND_LIVE_LIMIT,
  STAGING_BACKEND_REQUEST_START_WAIT_MS,
  STAGING_BACKEND_STARTUP_RESTORE_LIMIT,
  STAGING_BACKEND_STARTUP_TIMEOUT_MS,
  STAGING_PREVIEW_MODEL,
  FAILURE_SESSION_LOG_OUTPUT_LIMIT,
  createPreviewTarget,
  escapeSqliteStringLiteral,
  previewTargetLastActivityMs,
  removePreviewData,
  type PreviewTarget,
  type StagingPreviewProfile,
} from "./staging-preview-shared.js";
import {
  appendCapturedCommandOutput,
  renderCapturedCommandOutput,
  truncateFailureText,
  type CapturedCommandOutput,
} from "./staging-command-utils.js";
import { log } from "./staging-log.js";

export interface ActiveStagingBackend {
  child: ChildProcess;
  identity: Promise<ProcessIdentity | null>;
  baseUrl: string;
  port: number;
  output: CapturedCommandOutput;
  stopping: boolean;
  cleanup: () => Promise<void>;
  stagingDir: string;
  runtimePaths: RuntimePaths;
  lastAccessAt: number;
  inflightRequests: number;
}

type StagingBackendStartResult =
  | { ok: true }
  | { ok: false; error: string };

type StagingBackendStartFailure = {
  error: string;
  attempts: number;
  nextRetryAt: number;
};

const activeStagingBackends = new Map<string, ActiveStagingBackend>();
const activePreviewDataDirs = new Map<string, string>();
const activeStagingRouters = new Map<string, RequestHandler>();
const restorablePreviewTargets = new Map<string, PreviewTarget>();
const lazyStagingRouters = new Map<string, RequestHandler>();
const pendingStagingBackendStarts = new Map<string, Promise<StagingBackendStartResult>>();
const stagingBackendStartFailures = new Map<string, StagingBackendStartFailure>();

let backendIdleReaper: ReturnType<typeof setInterval> | null = null;
let _expressApp: express.Application | null = null;

export function registerExpressApp(app: express.Application): void {
  _expressApp = app;
}

export function hasRegisteredExpressApp(): boolean {
  return _expressApp !== null;
}

export function getStagingRouter(prefix: string): RequestHandler | undefined {
  return activeStagingRouters.get(prefix) ?? getLazyStagingRouter(prefix);
}

export function rememberRestorablePreviewTarget(target: PreviewTarget): void {
  restorablePreviewTargets.set(target.prefix, target);
}

export function hasStagingBackendState(prefix: string): boolean {
  return activeStagingBackends.has(prefix)
    || activePreviewDataDirs.has(prefix)
    || restorablePreviewTargets.has(prefix)
    || lazyStagingRouters.has(prefix)
    || pendingStagingBackendStarts.has(prefix)
    || stagingBackendStartFailures.has(prefix);
}

export function hasPendingStagingBackendStart(prefix: string): boolean {
  return pendingStagingBackendStarts.has(prefix);
}

export function hasActiveStagingBackend(prefix: string): boolean {
  return activeStagingBackends.has(prefix);
}

export async function cleanupStagingBackendResources(
  prefix: string,
  options: { removeData?: boolean } = {},
): Promise<void> {
  const removeData = options.removeData ?? true;
  restorablePreviewTargets.delete(prefix);
  lazyStagingRouters.delete(prefix);
  stagingBackendStartFailures.delete(prefix);

  const pendingStart = pendingStagingBackendStarts.get(prefix);
  if (pendingStart) {
    try {
      await pendingStart;
    } catch (error) {
      log(`Warning: pending staging backend start failed during cleanup for ${prefix}: ${error}`);
    } finally {
      stagingBackendStartFailures.delete(prefix);
    }
  }

  await teardownStagingBackend(prefix, { removeData: false });
  const ownedPreviewDataDir = activePreviewDataDirs.get(prefix);
  if (removeData && ownedPreviewDataDir) {
    try {
      removePreviewData(ownedPreviewDataDir);
    } catch (error) {
      log(`Warning: failed to remove preview data for ${prefix}: ${error}`);
    } finally {
      activePreviewDataDirs.delete(prefix);
    }
  }
}

export function forgetStagingPreviewBackend(prefix: string): void {
  restorablePreviewTargets.delete(prefix);
  lazyStagingRouters.delete(prefix);
  stagingBackendStartFailures.delete(prefix);
}

export function scheduleStartupBackendWarmup(
  targets: PreviewTarget[],
  isPreviewActive: (prefix: string) => boolean,
  writeLog: (msg: string) => void,
): void {
  if (STAGING_BACKEND_STARTUP_RESTORE_LIMIT <= 0) return;
  const warmTargets = [...targets]
    .sort((a, b) => previewTargetLastActivityMs(b) - previewTargetLastActivityMs(a))
    .slice(0, STAGING_BACKEND_STARTUP_RESTORE_LIMIT);
  if (warmTargets.length === 0) return;

  const timer = setTimeout(() => {
    void (async () => {
      for (const target of warmTargets) {
        if (!isPreviewActive(target.prefix)) continue;
        const result = await startStagingBackendOnce(target.prefix, target, "startup warmup");
        if (result.ok) {
          writeLog(`Warm restored staged backend for preview: ${target.prefix}`);
        }
      }
    })().catch((error) => {
      writeLog(`Warning: startup staged backend warmup failed: ${error}`);
    });
  }, 0);
  timer.unref?.();
}

export interface SeedStagingDataOptions {
  productionDataDir?: string;
}

export interface RestoreStagingBackendWithRetryOptions {
  attempts?: number;
  profile?: StagingPreviewProfile;
  initializeBackend?: (prefix: string, stagingDir: string, profile?: StagingPreviewProfile) => Promise<void>;
  log?: (msg: string) => void;
}

function clearSeededSqliteFiles(dataDir: string): void {
  for (const filename of ["bridge.db", "bridge.db-wal", "bridge.db-shm"]) {
    rmSync(join(dataDir, filename), { force: true });
  }
}

function snapshotProductionDatabase(dbSrc: string, dataDir: string): void {
  clearSeededSqliteFiles(dataDir);
  const prodDb = new DatabaseSync(dbSrc, { readOnly: true });
  try {
    const destPath = escapeSqliteStringLiteral(join(dataDir, "bridge.db").replaceAll("\\", "/"));
    prodDb.exec(`VACUUM INTO '${destPath}'`);
  } finally {
    prodDb.close();
  }
}

function cleanupFailedRestartSignal(signalFile: string): void {
  clearRestartPending();
  try { unlinkSync(signalFile); } catch {}
}

export function writeRestartSignalOrRollback(
  signalFile: string,
  validationMode: RestartValidationMode = "deploy",
  source = "staging_deploy",
  releaseCandidate?: RestartReleaseCandidate,
): number {
  const otherBusy = triggerRestartPending();
  try {
    writeRestartSignalFile(signalFile, { validationMode, source, releaseCandidate });
  } catch (error) {
    cleanupFailedRestartSignal(signalFile);
    throw error;
  }
  return otherBusy;
}

function forceStagingModelSettings(dbPath: string): void {
  let stagingDb: DatabaseSync | null = null;
  try {
    stagingDb = new DatabaseSync(dbPath);
    stagingDb.exec("PRAGMA journal_mode = WAL");
    createSettingsStore(stagingDb).updateSettings({
      model: STAGING_PREVIEW_MODEL,
      reasoningEffort: undefined,
    });
  } finally {
    if (stagingDb) {
      stagingDb.close();
    }
  }
}

function disableSchedulesInStagingDb(dbPath: string): void {
  let stagingDb: DatabaseSync | null = null;
  try {
    stagingDb = new DatabaseSync(dbPath);
    stagingDb.exec("PRAGMA journal_mode = WAL");
    stagingDb.exec("UPDATE schedules SET enabled = 0");
  } catch (err) {
    log(`Warning: could not disable schedules in staging DB: ${err}`);
  } finally {
    if (stagingDb) {
      try {
        stagingDb.close();
      } catch (closeErr) {
        log(`Warning: could not close staging DB after schedule disable: ${closeErr}`);
      }
    }
  }
}

function clearPushSubscriptionsInStagingDb(dbPath: string): void {
  let stagingDb: DatabaseSync | null = null;
  try {
    stagingDb = new DatabaseSync(dbPath);
    const table = stagingDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'").get();
    if (table) {
      stagingDb.exec("DELETE FROM push_subscriptions");
    }
  } catch (err) {
    log(`Warning: could not clear push subscriptions in staging DB: ${err}`);
  } finally {
    if (stagingDb) {
      try {
        stagingDb.close();
      } catch (closeErr) {
        log(`Warning: could not close staging DB after push subscription cleanup: ${closeErr}`);
      }
    }
  }
}

function resolveStagingPreviewRuntimePaths(stagingDir: string): RuntimePaths {
  const dataDir = join(stagingDir, "data");
  return resolveRuntimePaths(process.env, {
    distributionMode: "development",
    dataDir,
    docsDir: join(dataDir, "docs"),
    copilotHome: join(dataDir, ".copilot"),
  });
}

/** Seed a staging data directory from production data, with schedules disabled.
 *  Uses the worktree's own data/ directory (already gitignored). */
export function seedStagingData(stagingDir: string, options: SeedStagingDataOptions = {}): RuntimePaths {
  const runtimePaths = resolveStagingPreviewRuntimePaths(stagingDir);
  const dataDir = runtimePaths.dataDir;
  mkdirSync(dataDir, { recursive: true });

  const productionDataDir = options.productionDataDir ?? PRODUCTION_DATA_DIR;
  const dbSrc = join(productionDataDir, "bridge.db");

  if (!existsSync(dbSrc)) {
    clearSeededSqliteFiles(dataDir);
    throw new Error(`Production SQLite database not found at ${dbSrc}`);
  }

  try {
    snapshotProductionDatabase(dbSrc, dataDir);
  } catch (err) {
    clearSeededSqliteFiles(dataDir);
    throw new Error(
      `Unable to create safe staging SQLite snapshot with VACUUM INTO: ${err instanceof Error ? err.message : String(err)}. ` +
      `Staging preview aborted to avoid copying a live SQLite database non-atomically.`,
    );
  }
  disableSchedulesInStagingDb(join(dataDir, "bridge.db"));
  clearPushSubscriptionsInStagingDb(join(dataDir, "bridge.db"));
  forceStagingModelSettings(join(dataDir, "bridge.db"));

  // Copy docs directory (source of truth is filesystem, not SQLite)
  const docsSrc = join(productionDataDir, "docs");
  if (existsSync(docsSrc)) {
    cpSync(docsSrc, runtimePaths.docsDir, { recursive: true });
  }

  log(`Seeded staging data at ${dataDir}`);
  return runtimePaths;
}

export function getExistingPreviewRuntime(stagingDir: string, _profile: StagingPreviewProfile): RuntimePaths | null {
  const runtimePaths = resolveStagingPreviewRuntimePaths(stagingDir);
  const requiredPaths = [
    join(runtimePaths.dataDir, "bridge.db"),
    runtimePaths.docsDir,
  ];

  return requiredPaths.every((path) => existsSync(path)) ? runtimePaths : null;
}

interface PreparePreviewRuntimeOptions {
  preserveExisting?: boolean;
}

async function preparePreviewRuntime(
  stagingDir: string,
  profile: StagingPreviewProfile,
  options: PreparePreviewRuntimeOptions = {},
): Promise<RuntimePaths> {
  if (options.preserveExisting) {
    const existing = getExistingPreviewRuntime(stagingDir, profile);
    if (existing) return existing;
  }

  return Promise.resolve(seedStagingData(stagingDir));
}
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface StagingBackendStartOptions {
  entrypoint?: string;
  startupTimeoutMs?: number;
  tsxLoader?: string;
}

function backendOutputTail(output: CapturedCommandOutput): string {
  return truncateFailureText(renderCapturedCommandOutput("staging backend", output), FAILURE_SESSION_LOG_OUTPUT_LIMIT)
    ?? "(no child output captured)";
}

function proxyHeaders(headers: IncomingHttpHeaders, targetHost: string): IncomingHttpHeaders {
  const originalHost = headers["x-forwarded-host"] ?? headers.host;
  const nextHeaders: IncomingHttpHeaders = {
    ...headers,
    host: targetHost,
    ...(originalHost ? { "x-forwarded-host": originalHost } : {}),
  };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const header of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) {
    delete nextHeaders[header];
  }
  return nextHeaders;
}

function createUnavailableStagingHandler(prefix: string, detail: string): RequestHandler {
  return (_req, res) => {
    res.status(502).json({
      error: "Staging backend is not available",
      prefix,
      detail,
    });
  };
}

function getLazyStagingRouter(prefix: string): RequestHandler | undefined {
  if (!restorablePreviewTargets.has(prefix)) return undefined;

  let router = lazyStagingRouters.get(prefix);
  if (!router) {
    router = createLazyStagingHandler(prefix);
    lazyStagingRouters.set(prefix, router);
  }
  return router;
}

function createLazyStagingHandler(prefix: string): RequestHandler {
  return (req, res, next) => {
    void handleLazyStagingRequest(prefix, req, res, next);
  };
}

async function handleLazyStagingRequest(
  prefix: string,
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
): Promise<void> {
  const activeRouter = activeStagingRouters.get(prefix);
  if (activeRouter) {
    activeRouter(req, res, next);
    return;
  }

  const target = restorablePreviewTargets.get(prefix);
  if (!target) {
    next();
    return;
  }

  const startResult = await ensureStagingBackendStarted(prefix, target, {
    reason: "first API request",
    waitMs: STAGING_BACKEND_REQUEST_START_WAIT_MS,
  });
  if (startResult.state === "ready") {
    const router = activeStagingRouters.get(prefix);
    if (router) {
      router(req, res, next);
      return;
    }
    res.status(502).json({
      error: "Staging backend is not available",
      prefix,
      detail: "Backend reported ready but no proxy handler was registered.",
    });
    return;
  }

  res.setHeader("Retry-After", String(startResult.retryAfterSeconds));
  if (startResult.state === "starting") {
    res.status(503).json({
      error: "Staging backend is starting",
      prefix,
      retryAfterSeconds: startResult.retryAfterSeconds,
    });
    return;
  }

  res.status(502).json({
    error: "Staging backend is not available",
    prefix,
    detail: startResult.error,
    retryAfterSeconds: startResult.retryAfterSeconds,
  });
}

type EnsureStagingBackendResult =
  | { state: "ready" }
  | { state: "starting"; retryAfterSeconds: number }
  | { state: "failed"; error: string; retryAfterSeconds: number };

async function ensureStagingBackendStarted(
  prefix: string,
  target: PreviewTarget,
  options: { reason: string; waitMs: number },
): Promise<EnsureStagingBackendResult> {
  if (activeStagingBackends.has(prefix)) {
    return { state: "ready" };
  }

  const failure = stagingBackendStartFailures.get(prefix);
  const now = Date.now();
  if (failure && failure.nextRetryAt > now) {
    return {
      state: "failed",
      error: failure.error,
      retryAfterSeconds: Math.max(1, Math.ceil((failure.nextRetryAt - now) / 1_000)),
    };
  }

  const startPromise = startStagingBackendOnce(prefix, target, options.reason);
  if (options.waitMs <= 0) {
    return { state: "starting", retryAfterSeconds: 2 };
  }

  const result = await waitForStagingBackendStart(startPromise, options.waitMs);
  if (result === "pending") {
    return { state: "starting", retryAfterSeconds: 2 };
  }
  if (result.ok) {
    return { state: "ready" };
  }

  const currentFailure = stagingBackendStartFailures.get(prefix);
  return {
    state: "failed",
    error: result.error,
    retryAfterSeconds: currentFailure
      ? Math.max(1, Math.ceil((currentFailure.nextRetryAt - Date.now()) / 1_000))
      : Math.ceil(STAGING_BACKEND_FAILURE_BACKOFF_BASE_MS / 1_000),
  };
}

function startStagingBackendOnce(
  prefix: string,
  target: PreviewTarget,
  reason: string,
): Promise<StagingBackendStartResult> {
  const existing = pendingStagingBackendStarts.get(prefix);
  if (existing) return existing;

  const startPromise = startRestorableStagingBackend(prefix, target, reason)
    .finally(() => {
      pendingStagingBackendStarts.delete(prefix);
    });
  pendingStagingBackendStarts.set(prefix, startPromise);
  return startPromise;
}

async function waitForStagingBackendStart(
  promise: Promise<StagingBackendStartResult>,
  waitMs: number,
): Promise<StagingBackendStartResult | "pending"> {
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("pending"), waitMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      },
    );
  });
}

async function startRestorableStagingBackend(
  prefix: string,
  target: PreviewTarget,
  reason: string,
): Promise<StagingBackendStartResult> {
  if (activeStagingBackends.has(prefix)) return { ok: true };

  await enforceStagingBackendResourceLimits(`before starting ${prefix}`, {
    targetSize: Math.max(0, STAGING_BACKEND_LIVE_LIMIT - 1),
  });

  log(`Starting staged backend for ${prefix} (${reason})...`);
  const restoreResult = await restoreStagingBackendWithRetry(prefix, target.stagingDir, { profile: target.profile });
  if (restoreResult.restored) {
    stagingBackendStartFailures.delete(prefix);
    const backend = activeStagingBackends.get(prefix);
    if (backend) backend.lastAccessAt = Date.now();
    await enforceStagingBackendResourceLimits(`after starting ${prefix}`);
    return { ok: true };
  }

  const error = restoreResult.error ?? "Unknown staging backend startup failure";
  recordStagingBackendStartFailure(prefix, error);
  return { ok: false, error };
}

function recordStagingBackendStartFailure(
  prefix: string,
  error: string,
  options: { initialDelayMs?: number } = {},
): void {
  const previous = stagingBackendStartFailures.get(prefix);
  const attempts = (previous?.attempts ?? 0) + 1;
  const delayMs = options.initialDelayMs ?? Math.min(
    STAGING_BACKEND_FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 4),
    STAGING_BACKEND_FAILURE_BACKOFF_MAX_MS,
  );
  const nextRetryAt = Date.now() + delayMs;
  stagingBackendStartFailures.set(prefix, { error, attempts, nextRetryAt });
  log(`Staging backend start failed for ${prefix}; retry allowed in ${Math.ceil(delayMs / 1_000)}s: ${error}`);
}

function installStagingBackendIdleReaper(): void {
  if (backendIdleReaper) return;
  backendIdleReaper = setInterval(() => {
    if (activeStagingBackends.size === 0) return;
    void enforceStagingBackendResourceLimits("idle reaper").catch((error) => {
      log(`Warning: staging backend idle reaper failed: ${error}`);
    });
  }, STAGING_BACKEND_IDLE_REAPER_INTERVAL_MS);
  backendIdleReaper.unref?.();
}

async function enforceStagingBackendResourceLimits(
  reason: string,
  options: { targetSize?: number } = {},
): Promise<void> {
  const targetSize = options.targetSize ?? STAGING_BACKEND_LIVE_LIMIT;
  const now = Date.now();

  for (const [prefix, backend] of Array.from(activeStagingBackends.entries())) {
    if (backend.inflightRequests > 0 || backend.stopping) continue;
    if (now - backend.lastAccessAt >= STAGING_BACKEND_IDLE_TTL_MS) {
      log(`Stopping idle staged backend ${prefix} (${reason}); data preserved`);
      await teardownStagingBackend(prefix, { removeData: false });
    }
  }

  while (activeStagingBackends.size > targetSize) {
    const candidates = Array.from(activeStagingBackends.entries())
      .filter(([, backend]) => backend.inflightRequests === 0 && !backend.stopping)
      .sort(([, a], [, b]) => a.lastAccessAt - b.lastAccessAt);
    const candidate = candidates[0];
    if (!candidate) return;

    const [prefix] = candidate;
    log(`Stopping least-recent staged backend ${prefix} (${reason}); data preserved`);
    await teardownStagingBackend(prefix, { removeData: false });
  }
}

export function createStagingProxyHandler(prefix: string, backend: ActiveStagingBackend): RequestHandler {
  return (req, res) => {
    const registeredBackend = activeStagingBackends.get(prefix);
    if ((registeredBackend && registeredBackend !== backend) || backend.stopping) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({
        error: "Staging backend is restarting",
        prefix,
        retryAfterSeconds: 2,
      });
      return;
    }

    backend.lastAccessAt = Date.now();
    backend.inflightRequests++;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      backend.inflightRequests = Math.max(0, backend.inflightRequests - 1);
      backend.lastAccessAt = Date.now();
    };
    res.once("finish", complete);
    res.once("close", complete);

    const upstreamPath = `/api${req.url.startsWith("/") ? req.url : `/${req.url}`}`;
    const upstreamUrl = new URL(upstreamPath, backend.baseUrl);
    const upstreamReq = httpRequest(
      upstreamUrl,
      {
        method: req.method,
        headers: proxyHeaders(req.headers, upstreamUrl.host),
        agent: false,
      },
      (upstreamRes) => {
        res.statusCode = upstreamRes.statusCode ?? 502;
        res.statusMessage = upstreamRes.statusMessage ?? res.statusMessage;
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
            res.setHeader(name, value);
          }
        }
        res.flushHeaders();
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`Staging backend proxy error for ${prefix}: ${message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: "Staging backend proxy error", detail: message });
      } else {
        res.destroy(error instanceof Error ? error : new Error(message));
      }
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        upstreamReq.destroy();
      }
    });
    req.pipe(upstreamReq);
  };
}

function captureStagingBackendOutput(
  prefix: string,
  stream: "stdout" | "stderr",
  output: CapturedCommandOutput,
  chunk: unknown,
): void {
  appendCapturedCommandOutput(output, chunk);
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      log(`${prefix} ${stream}: ${line}`);
    }
  }
}

export function buildStagingBackendSpawnConfig(
  stagingDir: string,
  runtimePaths: RuntimePaths,
  apiBasePath: string,
  options: StagingBackendStartOptions = {},
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const requireFromStaging = createRequire(join(stagingDir, "package.json"));
  const tsxLoader = options.tsxLoader ?? pathToFileURL(requireFromStaging.resolve("tsx/esm")).href;
  const entrypoint = options.entrypoint ?? join(stagingDir, "src", "server", "staging-preview-server.ts");
  const env = prependNodePath({
    ...process.env,
    ...runtimePaths.env,
    BRIDGE_DISTRIBUTION_MODE: "development",
    [BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV]: "development",
    [BRIDGE_CONTROL_ROOT_ENV]: stagingDir,
    BRIDGE_ENV_FILE: join(stagingDir, ".env"),
    BRIDGE_STAGING_PREVIEW: "true",
    BRIDGE_STAGING_API_BASE_PATH: apiBasePath,
    BRIDGE_STAGING_BACKEND_PORT: "0",
    BRIDGE_STAGING_MODEL: STAGING_PREVIEW_MODEL,
  }, dirname(process.execPath));
  delete env.PORT;
  delete env[BRIDGE_ACTIVE_RELEASE_ROOT_ENV];

  return {
    command: process.execPath,
    args: ["--import", tsxLoader, entrypoint],
    env,
  };
}

const closedStagingBackendChildren = new WeakSet<ChildProcess>();

function trackChildClose(child: ChildProcess): void {
  child.once("close", () => {
    closedStagingBackendChildren.add(child);
  });
}

function streamIsClosed(stream: NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined): boolean {
  if (!stream) return true;
  const state = stream as { closed?: boolean; destroyed?: boolean };
  return state.destroyed === true || state.closed === true;
}

function childHasClosed(child: ChildProcess): boolean {
  if (closedStagingBackendChildren.has(child)) return true;
  if (child.exitCode === null && child.signalCode === null) return false;
  return !child.connected
    && streamIsClosed(child.stdout)
    && streamIsClosed(child.stderr)
    && streamIsClosed(child.stdin);
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasClosed(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolve(childHasClosed(child));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

async function stopStagingBackendChild(
  child: ChildProcess,
  identityPromise: Promise<ProcessIdentity | null>,
): Promise<void> {
  if (childHasClosed(child)) return;
  const deadline = createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS);
  const identityResult = await settleByDeadline(() => identityPromise, deadline);
  const identity = identityResult.status === "fulfilled" ? identityResult.value : null;
  if (!identity) {
    throw new Error("Staging backend creation identity was unavailable; refusing bare-PID termination.");
  }
  const result = await terminateProcessTree(identity, deadline);
  if (!result.ok) {
    const survivors = result.survivors?.map(({ pid }) => pid).join(",") ?? "none";
    throw new Error(
      `Staging backend process tree stop could not be verified: ${result.status}; `
      + `survivors=${survivors}${result.error ? `; ${result.error}` : ""}`,
    );
  }
  await waitForChildClose(child, remainingMs(deadline));
}

function handleStagingBackendExit(
  prefix: string,
  backend: ActiveStagingBackend,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (backend.stopping) return;
  const detail = `Child process exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`;
  log(`Staging backend crashed for ${prefix}: ${detail}`);
  activeStagingBackends.delete(prefix);
  activeStagingRouters.delete(prefix);
  recordStagingBackendStartFailure(prefix, detail, { initialDelayMs: 2_000 });
}

export async function startStagingBackendProcess(
  prefix: string,
  stagingDir: string,
  runtimePaths: RuntimePaths,
  apiBasePath: string,
  options: StagingBackendStartOptions = {},
): Promise<ActiveStagingBackend> {
  const spawnConfig = buildStagingBackendSpawnConfig(stagingDir, runtimePaths, apiBasePath, options);
  const output: CapturedCommandOutput = { output: "", truncatedChars: 0 };
  const child = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: stagingDir,
    env: spawnConfig.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    detached: shouldSpawnDetachedProcessGroup(),
  });
  trackChildClose(child);
  const identity = child.pid
    ? captureProcessIdentity(child.pid, createDeadline(STAGING_BACKEND_STARTUP_TIMEOUT_MS))
    : Promise.resolve(null);

  child.stdout?.on("data", (chunk) => captureStagingBackendOutput(prefix, "stdout", output, chunk));
  child.stderr?.on("data", (chunk) => captureStagingBackendOutput(prefix, "stderr", output, chunk));

  const startupTimeoutMs = options.startupTimeoutMs ?? STAGING_BACKEND_STARTUP_TIMEOUT_MS;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let backend: ActiveStagingBackend | null = null;
    const timeout = setTimeout(() => {
      fail(new Error(`Staging backend did not become ready within ${Math.ceil(startupTimeoutMs / 1_000)} seconds.`));
    }, startupTimeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopStagingBackendChild(child, identity).catch((cleanupError) => {
        log(`Warning: failed to stop staging backend after startup failure: ${cleanupError}`);
      });
      reject(new Error(`${error.message}\n\nChild output:\n${backendOutputTail(output)}`));
    };

    child.on("message", (message: unknown) => {
      if (settled) return;
      if (!message || typeof message !== "object") return;
      const typed = message as { type?: unknown; port?: unknown; error?: unknown };
      if (typed.type === "error") {
        fail(new Error(String(typed.error ?? "Staging backend startup failed")));
        return;
      }
      if (typed.type !== "ready") return;
      const port = Number(typed.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        fail(new Error(`Staging backend reported invalid port: ${String(typed.port)}`));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const baseUrl = `http://127.0.0.1:${port}`;
      backend = {
        child,
        identity,
        baseUrl,
        port,
        output,
        stopping: false,
        stagingDir,
        runtimePaths,
        lastAccessAt: Date.now(),
        inflightRequests: 0,
        cleanup: async () => {
          backend!.stopping = true;
          await stopStagingBackendChild(child, identity);
        },
      };
      resolve(backend);
    });

    child.once("error", (error) => {
      fail(error);
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        fail(new Error(`Staging backend exited before it was ready with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`));
        return;
      }
      if (backend) {
        handleStagingBackendExit(prefix, backend, code, signal);
      }
    });
  });
}

/** Tear down a staging backend. Idle eviction preserves data so lazy restore can resume it. */
async function teardownStagingBackend(
  prefix: string,
  options: { removeData?: boolean } = {},
): Promise<void> {
  const removeData = options.removeData ?? true;
  const staging = activeStagingBackends.get(prefix);
  if (staging) {
    staging.stopping = true;
  }
  activeStagingRouters.delete(prefix);
  if (!staging) return;

  log(`Tearing down staging backend: ${prefix}`);
  try {
    await staging.cleanup();
  } catch (err) {
    log(`Warning: staging cleanup error: ${err}`);
  }
  activeStagingBackends.delete(prefix);
  if (removeData) {
    removePreviewData(staging.runtimePaths.dataDir);
    activePreviewDataDirs.delete(prefix);
  }
  log(`Staging backend torn down: ${prefix}`);
}

export async function initializeStagingBackend(
  prefix: string,
  stagingDir: string,
  profile: StagingPreviewProfile = "clone",
): Promise<void> {
  await teardownStagingBackend(prefix, { removeData: false });
  const stalePreviewDataDir = activePreviewDataDirs.get(prefix)
    ?? join(stagingDir, "data");
  removePreviewData(stalePreviewDataDir);
  activePreviewDataDirs.delete(prefix);
  rememberRestorablePreviewTarget(createPreviewTarget(stagingDir, profile));

  let runtimePaths: RuntimePaths | null = null;

  try {
    runtimePaths = await preparePreviewRuntime(stagingDir, profile);
    activePreviewDataDirs.set(prefix, runtimePaths.dataDir);

    log(`Starting staged backend child process from ${stagingDir}...`);
    const stagingBackend = await startStagingBackendProcess(prefix, stagingDir, runtimePaths, `/staging/${prefix}/api`);
    activeStagingBackends.set(prefix, stagingBackend);
    activeStagingRouters.set(prefix, createStagingProxyHandler(prefix, stagingBackend));
    installStagingBackendIdleReaper();

    log(`Staged API registered for prefix ${prefix}`);
    log("Staging backend ready");
    await enforceStagingBackendResourceLimits(`after starting ${prefix}`);
  } catch (err) {
    activeStagingRouters.delete(prefix);
    activeStagingBackends.delete(prefix);
    if (runtimePaths) {
      removePreviewData(runtimePaths.dataDir);
    }
    activePreviewDataDirs.delete(prefix);
    throw err;
  }
}

async function restoreStagingBackend(
  prefix: string,
  stagingDir: string,
  profile: StagingPreviewProfile = "clone",
): Promise<void> {
  await teardownStagingBackend(prefix, { removeData: false });
  rememberRestorablePreviewTarget(createPreviewTarget(stagingDir, profile));

  let runtimePaths: RuntimePaths | null = null;

  try {
    runtimePaths = await preparePreviewRuntime(stagingDir, profile, { preserveExisting: true });
    activePreviewDataDirs.set(prefix, runtimePaths.dataDir);

    log(`Restoring staged backend child process from ${stagingDir}...`);
    const stagingBackend = await startStagingBackendProcess(prefix, stagingDir, runtimePaths, `/staging/${prefix}/api`);
    activeStagingBackends.set(prefix, stagingBackend);
    activeStagingRouters.set(prefix, createStagingProxyHandler(prefix, stagingBackend));
    installStagingBackendIdleReaper();

    log(`Staged API registered for prefix ${prefix}`);
    log("Staging backend ready");
  } catch (err) {
    activeStagingRouters.delete(prefix);
    activeStagingBackends.delete(prefix);
    throw err;
  }
}

export async function restoreStagingBackendWithRetry(
  prefix: string,
  stagingDir: string,
  options: RestoreStagingBackendWithRetryOptions = {},
): Promise<{ restored: boolean; attempts: number; error?: string }> {
  const maxAttempts = options.attempts ?? 2;
  const profile = options.profile ?? "clone";
  const initializeBackend = options.initializeBackend ?? restoreStagingBackend;
  const writeLog = options.log ?? log;

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initializeBackend(prefix, stagingDir, profile);
      return { restored: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        writeLog(
          `Failed to restore staged backend for ${prefix} on attempt ${attempt}/${maxAttempts}: ${lastError}`,
        );
      }
    }
  }

  return { restored: false, attempts: maxAttempts, error: lastError };
}

export const __testing = {
  seedPreviewDataDir(prefix: string, dataDir: string): void {
    activePreviewDataDirs.set(prefix, dataDir);
  },
  hasPreviewDataDir(prefix: string): boolean {
    return activePreviewDataDirs.has(prefix);
  },
  resetBackendState(): void {
    activeStagingBackends.clear();
    activePreviewDataDirs.clear();
    activeStagingRouters.clear();
    restorablePreviewTargets.clear();
    lazyStagingRouters.clear();
    pendingStagingBackendStarts.clear();
    stagingBackendStartFailures.clear();
  },
};
