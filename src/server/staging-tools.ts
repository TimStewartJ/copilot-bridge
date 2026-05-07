// Per-session staging worktrees for validated code deployment
// Each session gets an isolated worktree to make changes, run quality checks,
// and deploy only after validation passes.

import { defineTool } from "@github/copilot-sdk";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, rmSync, lstatSync, copyFileSync, cpSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dependencySyncHash, DEPENDENCY_SYNC_GIT_PATHSPEC, preparePatchedPackagesForInstall } from "./dependency-sync.js";
import { preserveOrCreateRollbackCheckpoint, removeRollbackCheckpointIfCreated } from "./pre-deploy-checkpoint.js";
import { isRestartPending, triggerRestartPending } from "./session-manager.js";
import { createDirectoryLink, killProcessTree, removeDirectoryLink } from "./platform.js";
import { buildPublicUrl } from "./tunnel.js";
import { DEPLOY_GATE, PREVIEW_GATE, runValidationGateAsync } from "./validation-pipeline.js";
import { config } from "./config.js";
import { isBridgeReleaseMode } from "./distribution-mode.js";
import { toolFailure } from "./tool-results.js";
import {
  buildCommandFailureOutput,
  extractCommandFailureLogPath,
  extractCommandFailureLogWriteError,
  writeValidationCommandLog,
} from "./validation-command-log.js";
import { createValidationCommandEnv, prependNodePath } from "./validation-command-env.js";
import type { AppContext } from "./app-context.js";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths.js";
import type express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTION_ROOT = join(__dirname, "..", "..");
const STAGING_PARENT = join(PRODUCTION_ROOT, "..", "bridge-staging");
const SIGNAL_FILE= join(PRODUCTION_ROOT, "data", "restart.signal");
const PRE_DEPLOY_SHA_FILE = join(PRODUCTION_ROOT, "data", "pre-deploy-sha");
const PRODUCTION_DATA_DIR = join(PRODUCTION_ROOT, "data");
const LEGACY_STAGING_DIST_PARENT = join(PRODUCTION_ROOT, "dist", "staging");
const STAGING_PREVIEW_DIR_ENV = "BRIDGE_STAGING_PREVIEW_DIR";
const OPTIONAL_STAGING_MODULE_ERROR_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);
const FAILURE_DETAIL_OUTPUT_LIMIT = 500;
const FAILURE_SESSION_LOG_OUTPUT_LIMIT = 4_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_OUTPUT_CAPTURE_LIMIT = 1024 * 1024;
const DEMO_PREVIEW_SUFFIX = "-demo";
const STAGING_INSTALL_COMMAND = "npm install --no-audit --no-fund --include=dev";
const STAGING_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const STAGING_PREVIEW_PARENT = resolveConfiguredPath(
  process.env[STAGING_PREVIEW_DIR_ENV],
  join(PRODUCTION_DATA_DIR, "staging-previews"),
);

export type StagingPreviewProfile = "clone" | "demo";

interface PreviewTarget {
  prefix: string;
  profile: StagingPreviewProfile;
  stagingDir: string;
  basePath: string;
  outDir: string;
}

interface ActiveStagingBackend {
  ctx: AppContext;
  router?: express.Router;
  db?: DatabaseSync;
  cleanup: () => Promise<void>;
  stagingDir: string;
  runtimePaths: RuntimePaths;
}

type LegacyTodoStore = {
  listTodos: (taskId: string) => unknown[];
  getTodo: (id: string) => unknown;
  createTodo: (taskId: string | null, text: string, deadline?: string) => unknown;
  updateTodo: (id: string, updates: Record<string, unknown>) => unknown;
  deleteTodo: (id: string) => void;
  reorderTodos: (taskId: string, todoIds: string[]) => unknown[];
  listAllOpen: () => unknown[];
  listRecentlyCompleted: () => unknown[];
};

type StagingAppContext = AppContext & { todoStore?: LegacyTodoStore };

function resolveConfiguredPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? resolve(PRODUCTION_ROOT, trimmed) : fallback;
}

function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function listStagingPreviewParents(): string[] {
  return uniqueResolvedPaths([STAGING_PREVIEW_PARENT, LEGACY_STAGING_DIST_PARENT]);
}

function createNoopSessionWorkspaceStore() {
  return {
    getWorkspace: () => undefined,
    setWorkspace: (_sessionId: string, cwd: string) => ({ cwd, updatedAt: new Date().toISOString() }),
    deleteWorkspace: () => {},
    listWorkspaces: () => ({}),
  };
}

function createNoopChecklistStore() {
  return {
    listChecklistItems: () => [],
    getChecklistItem: () => undefined,
    createChecklistItem: (_taskId: string | null, text: string, _deadline?: string) => ({
      id: "",
      taskId: null,
      text,
      done: false,
      order: 0,
      createdAt: new Date().toISOString(),
    }),
    updateChecklistItem: () => {
      throw new Error("Checklist store is not available in this staging worktree.");
    },
    deleteChecklistItem: () => {},
    reorderChecklistItems: () => [],
    listAllOpenChecklistItems: () => [],
    listRecentlyCompletedChecklistItems: () => [],
  };
}

function resolvePreviewProfile(value?: string): StagingPreviewProfile {
  return value === "demo" ? "demo" : "clone";
}

export function buildPreviewPrefix(stagingDir: string, profile: StagingPreviewProfile = "clone"): string {
  const prefix = basename(stagingDir);
  return profile === "demo" ? `${prefix}${DEMO_PREVIEW_SUFFIX}` : prefix;
}

export function parsePreviewPrefix(
  prefix: string,
  activeWorktrees?: ReadonlySet<string>,
): { stagingName: string; profile: StagingPreviewProfile } | null {
  if (activeWorktrees?.has(prefix)) {
    return { stagingName: prefix, profile: "clone" };
  }

  if (prefix.endsWith(DEMO_PREVIEW_SUFFIX)) {
    const stagingName = prefix.slice(0, -DEMO_PREVIEW_SUFFIX.length);
    if (!stagingName) return null;
    if (!activeWorktrees || activeWorktrees.has(stagingName)) {
      return { stagingName, profile: "demo" };
    }
  }

  if (activeWorktrees && !activeWorktrees.has(prefix)) {
    return null;
  }

  return { stagingName: prefix, profile: "clone" };
}

function escapeSqliteStringLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function copySqliteSnapshot(dbSrc: string, destDb: string): void {
  copyFileSync(dbSrc, destDb);
  for (const suffix of ["-wal", "-shm"]) {
    const src = `${dbSrc}${suffix}`;
    const dest = `${destDb}${suffix}`;
    if (existsSync(src)) {
      copyFileSync(src, dest);
    } else if (existsSync(dest)) {
      rmSync(dest, { force: true });
    }
  }
}

function createPreviewTarget(stagingDir: string, profile: StagingPreviewProfile = "clone"): PreviewTarget {
  const prefix = buildPreviewPrefix(stagingDir, profile);
  return {
    prefix,
    profile,
    stagingDir,
    basePath: `/staging/${prefix}/`,
    outDir: join(STAGING_PREVIEW_PARENT, prefix),
  };
}

function listPreviewTargetsForStagingDir(stagingDir: string): PreviewTarget[] {
  return [
    createPreviewTarget(stagingDir, "clone"),
    createPreviewTarget(stagingDir, "demo"),
  ];
}

async function cleanupPreviewArtifactsForStagingDir(stagingDir: string): Promise<void> {
  for (const target of listPreviewTargetsForStagingDir(stagingDir)) {
    await cleanupPreviewTarget(stagingDir, target.profile);
  }
}

async function cleanupPreviewResources(prefix: string, options: { removeDist?: boolean } = {}): Promise<void> {
  const removeDist = options.removeDist ?? true;
  const ownedPreviewDataDir = activePreviewDataDirs.get(prefix);
  const ownedByThisProcess = activePreviews.has(prefix)
    || activeStagingBackends.has(prefix)
    || !!ownedPreviewDataDir;
  if (!ownedByThisProcess) return;

  await teardownStagingBackend(prefix);
  if (removeDist) {
    removeStagingDist(prefix);
  }
  if (ownedPreviewDataDir && existsSync(ownedPreviewDataDir)) {
    removePreviewData(ownedPreviewDataDir);
  }
  activePreviewDataDirs.delete(prefix);
}

export async function cleanupPreviewTarget(
  stagingDir: string,
  profile: StagingPreviewProfile = "clone",
): Promise<void> {
  const target = createPreviewTarget(stagingDir, profile);
  await cleanupPreviewResources(target.prefix);
}

export function shouldManageStagingArtifacts(): boolean {
  return process.env.BRIDGE_DEMO_MODE !== "true" && !isBridgeReleaseMode(process.env, PRODUCTION_ROOT);
}

function isMissingOptionalStagingModule(error: unknown, specifier: string): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (!OPTIONAL_STAGING_MODULE_ERROR_CODES.has(code)) return false;

  const rawSpecifier = specifier.replace(/\?.*$/, "");
  const resolvedSpecifier = rawSpecifier.startsWith("file:") ? fileURLToPath(rawSpecifier) : rawSpecifier;
  const message = error instanceof Error ? error.message : String(error);
  const missingTarget = message.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/)?.[1];
  if (!missingTarget) return false;
  const rawMissingTarget = missingTarget.replace(/\?.*$/, "");
  if (
    missingTarget === specifier
    || missingTarget === rawSpecifier
    || missingTarget === resolvedSpecifier
    || rawMissingTarget === rawSpecifier
    || rawMissingTarget === resolvedSpecifier
  ) {
    return true;
  }
  if (!rawMissingTarget.startsWith("file:")) return false;
  try {
    return fileURLToPath(rawMissingTarget) === resolvedSpecifier;
  } catch {
    return false;
  }
}

async function importOptionalStagingModule(specifier: string) {
  try {
    return await import(specifier);
  } catch (error) {
    if (isMissingOptionalStagingModule(error, specifier)) {
      return null;
    }
    throw error;
  }
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

/** Active staging previews: prefix → dist path */
const activePreviews = new Map<string, string>();

/** Active staging backend contexts: prefix → cleanup function */
const activeStagingBackends = new Map<string, ActiveStagingBackend>();

/** Preview data directories created by this process: prefix → data dir */
const activePreviewDataDirs = new Map<string, string>();

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
  for (const previewParent of listStagingPreviewParents()) {
    const distDir = join(previewParent, prefix);
    if (existsSync(distDir)) {
      rmSync(distDir, { recursive: true, force: true });
    }
  }
  activePreviews.delete(prefix);
}

function removePreviewData(dataDir: string): void {
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

interface SeedStagingDataOptions {
  productionDataDir?: string;
}

interface RestoreStagingBackendWithRetryOptions {
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

/** Seed a staging data directory from production data, with schedules disabled.
 *  Uses the worktree's own data/ directory (already gitignored). */
function seedStagingData(stagingDir: string, options: SeedStagingDataOptions = {}): RuntimePaths {
  const dataDir = join(stagingDir, "data");
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
    log(`Warning: SQLite VACUUM INTO failed, falling back to file copy: ${err}`);
    copySqliteSnapshot(dbSrc, join(dataDir, "bridge.db"));
  }
  disableSchedulesInStagingDb(join(dataDir, "bridge.db"));
  clearPushSubscriptionsInStagingDb(join(dataDir, "bridge.db"));

  // Copy docs directory (source of truth is filesystem, not SQLite)
  const docsSrc = join(productionDataDir, "docs");
  if (existsSync(docsSrc)) {
    cpSync(docsSrc, join(dataDir, "docs"), { recursive: true });
  }

  log(`Seeded staging data at ${dataDir}`);
  return resolveRuntimePaths(process.env, {
    demoMode: false,
    dataDir,
    docsDir: join(dataDir, "docs"),
    copilotHome: join(dataDir, ".copilot"),
  });
}

async function seedDemoPreviewData(stagingDir: string): Promise<RuntimePaths> {
  const moduleUrl = `${pathToFileURL(join(stagingDir, "src", "server", "demo-workspace.ts")).href}?v=${Date.now()}`;
  const demoWorkspaceMod = await import(moduleUrl) as {
    resetDemoWorkspace?: (repoRoot: string) => { dataDir: string; docsDir: string; copilotHome: string; workspaceDir: string };
  };

  if (typeof demoWorkspaceMod.resetDemoWorkspace !== "function") {
    throw new Error("Demo preview requires src/server/demo-workspace.ts to export resetDemoWorkspace()");
  }

  const demoWorkspace = demoWorkspaceMod.resetDemoWorkspace(stagingDir);
  log(`Seeded demo preview data at ${demoWorkspace.dataDir}`);
  return resolveRuntimePaths(process.env, {
    demoMode: true,
    dataDir: demoWorkspace.dataDir,
    docsDir: demoWorkspace.docsDir,
    copilotHome: demoWorkspace.copilotHome,
    workspaceDir: demoWorkspace.workspaceDir,
  });
}

function getExistingPreviewRuntime(stagingDir: string, profile: StagingPreviewProfile): RuntimePaths | null {
  const dataDir = join(stagingDir, profile === "demo" ? "demo-data" : "data");
  const runtimePaths = resolveRuntimePaths(process.env, {
    demoMode: profile === "demo",
    dataDir,
    docsDir: join(dataDir, "docs"),
    copilotHome: join(dataDir, ".copilot"),
  });
  const requiredPaths = [
    join(runtimePaths.dataDir, "bridge.db"),
    runtimePaths.docsDir,
    ...(runtimePaths.demoMode && runtimePaths.workspaceDir ? [runtimePaths.workspaceDir] : []),
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

  return profile === "demo"
    ? seedDemoPreviewData(stagingDir)
    : Promise.resolve(seedStagingData(stagingDir));
}
/** Dynamically import staged backend modules and create an isolated AppContext */
async function createStagingContext(
  stagingDir: string,
  runtimePaths: RuntimePaths,
  apiBasePath: string,
): Promise<{ ctx: AppContext; db: DatabaseSync }> {
  const base = pathToFileURL(join(stagingDir, "src", "server")).href;
  const ts = (file: string) => `${base}/${file}?v=${Date.now()}`;

  // Dynamic imports from the staging worktree
  const [globalBusMod, eventBusMod, dbMod,
    taskStoreMod, taskGroupStoreMod,
    scheduleStoreMod, settingsStoreMod, sessionMetaStoreMod, sessionWorkspaceStoreMod,
    sessionTitlesMod, readStateStoreMod, checklistStoreMod, todoStoreMod,
    docsStoreMod, docsIndexMod, docsSnapshotStoreMod, sessionManagerMod, apiRouterMod,
    tagStoreMod,
    mcpServerStoreMod,
    telemetryStoreMod,
    transcriptionServiceMod,
    voiceJobStoreMod,
    voiceJobManagerMod,
    deferredPromptStoreMod,
    deferLoopStoreMod,
    deferredPromptRunnerMod,
    deferLoopRunnerMod,
    deferDeliveryGuardMod,
    schedulerMod,
    pushSubscriptionStoreMod,
    pushNotificationServiceMod,
  ] = await Promise.all([
    import(ts("global-bus.ts")),
    import(ts("event-bus.ts")),
    import(ts("db.ts")),
    import(ts("task-store.ts")),
    import(ts("task-group-store.ts")),
    import(ts("schedule-store.ts")),
    import(ts("settings-store.ts")),
    import(ts("session-meta-store.ts")),
    importOptionalStagingModule(ts("session-workspace-store.ts")),
    import(ts("session-titles.ts")),
    import(ts("read-state-store.ts")),
    importOptionalStagingModule(ts("checklist-store.ts")),
    importOptionalStagingModule(ts("todo-store.ts")),
    importOptionalStagingModule(ts("docs-store.ts")),
    importOptionalStagingModule(ts("docs-index.ts")),
    importOptionalStagingModule(ts("docs-snapshot-store.ts")),
    import(ts("session-manager.ts")),
    import(ts("api-router.ts")),
    importOptionalStagingModule(ts("tag-store.ts")),
    importOptionalStagingModule(ts("mcp-server-store.ts")),
    importOptionalStagingModule(ts("telemetry-store.ts")),
    importOptionalStagingModule(ts("transcription-service.ts")),
    importOptionalStagingModule(ts("voice-job-store.ts")),
    importOptionalStagingModule(ts("voice-job-manager.ts")),
    importOptionalStagingModule(ts("deferred-prompt-store.ts")),
    importOptionalStagingModule(ts("defer-loop-store.ts")),
    importOptionalStagingModule(ts("deferred-prompt-runner.ts")),
    importOptionalStagingModule(ts("defer-loop-runner.ts")),
    importOptionalStagingModule(ts("defer-delivery-guard.ts")),
    importOptionalStagingModule(ts("scheduler.ts")),
    importOptionalStagingModule(ts("push-subscription-store.ts")),
    importOptionalStagingModule(ts("push-notification-service.ts")),
  ]);
  // Open isolated staging database
  const db = dbMod.openDatabase(runtimePaths.dataDir);
  try {
    // Create isolated instances
    const globalBus = globalBusMod.createGlobalBus();
    const eventBusRegistry = eventBusMod.createEventBusRegistry();
    const taskStore = taskStoreMod.createTaskStore(db, globalBus, { runtimePaths });
    const taskGroupStore = taskGroupStoreMod.createTaskGroupStore(db);
    const scheduleStore = scheduleStoreMod.createScheduleStore(db);
    const settingsStore = settingsStoreMod.createSettingsStore(db);
    const sessionMetaStore = sessionMetaStoreMod.createSessionMetaStore(db);
    const sessionWorkspaceStore = sessionWorkspaceStoreMod?.createSessionWorkspaceStore?.(db)
      ?? createNoopSessionWorkspaceStore();
    const sessionTitles = sessionTitlesMod.createSessionTitlesStore(db);
    const readStateStore = readStateStoreMod.createReadStateStore(db);
    const checklistStore = checklistStoreMod?.createChecklistStore?.(db, globalBus)
      ?? createNoopChecklistStore();
    const todoStore = todoStoreMod?.createTodoStore?.(db, globalBus);
    const tagStore = tagStoreMod?.createTagStore(db);
    const mcpServerStore = mcpServerStoreMod?.createMcpServerStore(db);
    const telemetryStore = telemetryStoreMod?.createTelemetryStore(db);
    const transcriptionService = transcriptionServiceMod?.createTranscriptionService();
    const docsStore = docsStoreMod?.createDocsStore(runtimePaths.docsDir);
    const docsIndex = docsStore && docsIndexMod ? docsIndexMod.createDocsIndex(db, docsStore) : null;
    const docsSnapshotStore = docsStore && docsSnapshotStoreMod
      ? docsSnapshotStoreMod.createDocsSnapshotStore(
          runtimePaths.docsDir,
          runtimePaths.docsSnapshotsDir ?? join(runtimePaths.dataDir, "backups", "docs", "snapshots"),
        )
      : null;
    if (docsIndex) docsIndex.reindex();
    const deferredPromptStore = deferredPromptStoreMod?.createDeferredPromptStore?.(db);
    const deferLoopStore = deferLoopStoreMod?.createDeferLoopStore?.(db);
    const deferDeliveryGuard = deferDeliveryGuardMod?.createDeferDeliveryGuard?.();
    const pushSubscriptionStore = pushSubscriptionStoreMod?.createPushSubscriptionStore?.(db);

    // COPILOT_HOME isolates session storage so listSessions() only returns staging sessions
    const copilotHome = runtimePaths.copilotHome ?? join(runtimePaths.dataDir, ".copilot");
    mkdirSync(copilotHome, { recursive: true });

    const ctx: StagingAppContext = {
      taskStore, taskGroupStore, scheduleStore, settingsStore,
      sessionMetaStore, sessionWorkspaceStore, sessionTitles, readStateStore, checklistStore,
      ...(todoStore && { todoStore }),
      ...(docsStore && { docsStore }),
      ...(docsIndex && { docsIndex }),
      ...(docsSnapshotStore && { docsSnapshotStore }),
      ...(tagStore && { tagStore }),
      ...(mcpServerStore && { mcpServerStore }),
      ...(telemetryStore && { telemetryStore }),
      ...(deferredPromptStore && { deferredPromptStore }),
      ...(deferLoopStore && { deferLoopStore }),
      ...(schedulerMod && { scheduler: schedulerMod }),
      globalBus, eventBusRegistry,
      sessionManager: null as any,
      transcriptionService: transcriptionService ?? {
        getStatus: () => ({
          available: false,
          provider: "disabled",
          label: "Unavailable",
          reason: "Voice input is not configured on the staging server.",
          maxDurationSeconds: 120,
        }),
        transcribe: async () => {
          throw new Error("Voice input is not configured on the staging server.");
        },
      },
      voiceJobManager: null as any,
      ...(pushSubscriptionStore && { pushSubscriptionStore }),
      copilotHome,
      apiBasePath,
      runtimePaths,
      isStaging: true,
    };

    // Create bridge tools for staging (exclude dangerous tools)
    const allTools = sessionManagerMod.createBridgeTools(ctx);
    const excludeTools = new Set(["self_restart", "staging_init", "staging_preview", "staging_deploy", "staging_cleanup"]);
    const stagingTools = allTools.filter((t: any) => !excludeTools.has(t.name));

    // Create a real SessionManager via the worktree's factory — new deps are picked up
    // automatically without updating this file (see createSessionManager in session-manager.ts)
    const sm = sessionManagerMod.createSessionManager(ctx, {
      tools: stagingTools,
      config: { get sessionMcpServers() { return settingsStore.getMcpServers(); }, model: "claude-haiku-4.5" },
      clientEnv: runtimePaths.env,
      copilotHome,
      runtimePaths,
    });
    ctx.sessionManager = sm;
    if (deferredPromptStore && deferredPromptRunnerMod?.createDeferredPromptRunner) {
      ctx.deferredPromptRunner = deferredPromptRunnerMod.createDeferredPromptRunner(
        deferredPromptStore,
        sm,
        globalBus,
        deferDeliveryGuard,
        { deferredPromptStore, deferLoopStore },
      );
    }
    if (deferLoopStore && deferLoopRunnerMod?.createDeferLoopRunner) {
      ctx.deferLoopRunner = deferLoopRunnerMod.createDeferLoopRunner(
        deferLoopStore,
        sm,
        globalBus,
        deferDeliveryGuard,
        { deferredPromptStore, deferLoopStore },
      );
    }
    ctx.voiceJobManager = voiceJobStoreMod && voiceJobManagerMod
      ? voiceJobManagerMod.createVoiceJobManager({
          dataDir: runtimePaths.dataDir,
          store: voiceJobStoreMod.createVoiceJobStore(db),
          transcriptionService: ctx.transcriptionService,
          sessionManager: sm,
          taskStore,
          taskGroupStore,
        })
      : {
          acceptVoiceJob: async () => {
            throw new Error("Voice jobs are not available in this staging worktree.");
          },
          getVoiceJob: () => undefined,
          findLatestRelevantForComposer: () => undefined,
          markRecovered: () => undefined,
          resumePendingJobs: () => {},
          shutdown: async () => {},
        } as any;
    if (pushSubscriptionStore && pushNotificationServiceMod?.createPushNotificationService) {
      ctx.pushNotificationService = pushNotificationServiceMod.createPushNotificationService({
        subscriptionStore: pushSubscriptionStore,
        env: runtimePaths.env,
      });
      pushNotificationServiceMod.initPushEventNotifications?.(ctx, ctx.pushNotificationService);
    }

    // Store the apiRouter factory for mounting
    (ctx as any)._createApiRouter = apiRouterMod.createApiRouter;

    return { ctx, db };
  } catch (err) {
    try {
      db.close();
    } catch (closeErr) {
      log(`Warning: staging DB close error after context failure: ${closeErr}`);
    }
    throw err;
  }
}
function createActiveStagingBackendRecord(
  ctx: AppContext,
  stagingDir: string,
  runtimePaths: RuntimePaths,
  db?: DatabaseSync,
): ActiveStagingBackend {
  return {
    ctx,
    db,
    stagingDir,
    runtimePaths,
    cleanup: createStagingBackendCleanup(ctx),
  };
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
  removePreviewData(staging.runtimePaths.dataDir);
  activePreviewDataDirs.delete(prefix);
  log(`Staging backend torn down: ${prefix}`);
}

function createStagingBackendCleanup(ctx: AppContext): () => Promise<void> {
  return async () => {
    try {
      ctx.deferredPromptRunner?.shutdown();
      ctx.deferLoopRunner?.shutdown();
      ctx.scheduler?.shutdown();
      await ctx.voiceJobManager.shutdown();
      await ctx.sessionManager.gracefulShutdown();
    } catch (err) {
      log(`Warning: staging SDK shutdown error: ${err}`);
    }
  };
}

function initializeStagingScheduler(ctx: AppContext): void {
  ctx.scheduler?.initialize?.(ctx.sessionManager, {
    scheduleStore: ctx.scheduleStore,
    taskStore: ctx.taskStore,
    sessionMetaStore: ctx.sessionMetaStore,
    globalBus: ctx.globalBus,
  });
}

async function initializeStagingBackend(
  prefix: string,
  stagingDir: string,
  profile: StagingPreviewProfile = "clone",
): Promise<void> {
  await teardownStagingBackend(prefix);
  const stalePreviewDataDir = activePreviewDataDirs.get(prefix)
    ?? join(stagingDir, profile === "demo" ? "demo-data" : "data");
  removePreviewData(stalePreviewDataDir);
  activePreviewDataDirs.delete(prefix);

  let ctx: AppContext | null = null;
  let stagingDb: DatabaseSync | undefined;
  let runtimePaths: RuntimePaths | null = null;

  try {
    runtimePaths = await preparePreviewRuntime(stagingDir, profile);
    activePreviewDataDirs.set(prefix, runtimePaths.dataDir);

    log(`Creating staging backend context from ${stagingDir}...`);
    const created = await createStagingContext(stagingDir, runtimePaths, `/staging/${prefix}/api`);
    ctx = created.ctx;
    stagingDb = created.db;
    const stagingBackend = createActiveStagingBackendRecord(ctx, stagingDir, runtimePaths, stagingDb);
    activeStagingBackends.set(prefix, stagingBackend);

    log("Initializing staging Copilot SDK...");
    await ctx.sessionManager.initialize();
    initializeStagingScheduler(ctx);
    ctx.deferredPromptRunner?.start();
    ctx.deferLoopRunner?.start();
    ctx.voiceJobManager.resumePendingJobs();

    const createRouter = (ctx as any)._createApiRouter;
    const stagedRouter = createRouter(ctx);
    activeStagingRouters.set(prefix, stagedRouter);
    stagingBackend.router = stagedRouter;

    log(`Staged API registered for prefix ${prefix}`);
    log("Staging backend ready");
  } catch (err) {
    activeStagingRouters.delete(prefix);
    activeStagingBackends.delete(prefix);
    if (ctx) {
      try {
        await createStagingBackendCleanup(ctx)();
      } catch {
        // createStagingBackendCleanup already logs concrete shutdown failures
      }
    }
    if (stagingDb) {
      try {
        stagingDb.close();
      } catch (dbErr) {
        log(`Warning: staging DB close error: ${dbErr}`);
      }
    }
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
  await teardownStagingBackend(prefix);

  let ctx: AppContext | null = null;
  let stagingDb: DatabaseSync | undefined;
  let runtimePaths: RuntimePaths | null = null;

  try {
    runtimePaths = await preparePreviewRuntime(stagingDir, profile, { preserveExisting: true });
    activePreviewDataDirs.set(prefix, runtimePaths.dataDir);

    log(`Creating staging backend context from ${stagingDir}...`);
    const created = await createStagingContext(stagingDir, runtimePaths, `/staging/${prefix}/api`);
    ctx = created.ctx;
    stagingDb = created.db;
    const stagingBackend = createActiveStagingBackendRecord(ctx, stagingDir, runtimePaths, stagingDb);
    activeStagingBackends.set(prefix, stagingBackend);

    log("Initializing staging Copilot SDK...");
    await ctx.sessionManager.initialize();
    initializeStagingScheduler(ctx);
    ctx.deferredPromptRunner?.start();
    ctx.deferLoopRunner?.start();
    ctx.voiceJobManager.resumePendingJobs();

    const createRouter = (ctx as any)._createApiRouter;
    const stagedRouter = createRouter(ctx);
    activeStagingRouters.set(prefix, stagedRouter);
    stagingBackend.router = stagedRouter;

    log(`Staged API registered for prefix ${prefix}`);
    log("Staging backend ready");
  } catch (err) {
    activeStagingRouters.delete(prefix);
    activeStagingBackends.delete(prefix);
    if (ctx) {
      try {
        await createStagingBackendCleanup(ctx)();
      } catch {
        // createStagingBackendCleanup already logs concrete shutdown failures
      }
    }
    if (stagingDb) {
      try {
        stagingDb.close();
      } catch (dbErr) {
        log(`Warning: staging DB close error: ${dbErr}`);
      }
    }
    activePreviewDataDirs.delete(prefix);
    throw err;
  }
}

async function restoreStagingBackendWithRetry(
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

function log(msg: string) {
  console.log(`[staging] ${msg}`);
}

type CapturedCommandOutput = {
  output: string;
  truncatedChars: number;
};

function appendCapturedCommandOutput(capture: CapturedCommandOutput, chunk: unknown): void {
  const text = String(chunk);
  if (!text) return;

  if (text.length >= COMMAND_OUTPUT_CAPTURE_LIMIT) {
    capture.truncatedChars += capture.output.length + text.length - COMMAND_OUTPUT_CAPTURE_LIMIT;
    capture.output = text.slice(-COMMAND_OUTPUT_CAPTURE_LIMIT);
    return;
  }

  const combinedLength = capture.output.length + text.length;
  if (combinedLength <= COMMAND_OUTPUT_CAPTURE_LIMIT) {
    capture.output += text;
    return;
  }

  const droppedChars = combinedLength - COMMAND_OUTPUT_CAPTURE_LIMIT;
  capture.truncatedChars += droppedChars;
  capture.output = (capture.output + text).slice(droppedChars);
}

function renderCapturedCommandOutput(label: string, capture: CapturedCommandOutput): string {
  if (capture.truncatedChars === 0) return capture.output;
  const notice =
    `[${label} truncated: kept last ${capture.output.length} characters, dropped ${capture.truncatedChars} characters.]`;
  return joinFailureSections(capture.output, notice) ?? notice;
}

async function run(
  cmd: string,
  cwd: string,
  options: { timeoutMs?: number; isolateRuntimeEnv?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  // Prepend the running process's Node directory to PATH so npx/vitest/tsc/vite
  // resolve the correct Node binary (v22+ required for node:sqlite) instead of
  // whatever older `node` happens to be first on the system PATH.
  const nodeDir = dirname(process.execPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const validationEnv = options.isolateRuntimeEnv
    ? createValidationCommandEnv(process.env, { nodeDir, prefix: "bridge-staging-validation-" })
    : undefined;
  const env = validationEnv?.env ?? prependNodePath(process.env, nodeDir);
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    const child = spawn(cmd, { cwd, env, shell: true, windowsHide: true });
    const stdout: CapturedCommandOutput = { output: "", truncatedChars: 0 };
    const stderr: CapturedCommandOutput = { output: "", truncatedChars: 0 };
    let spawnError: Error | undefined;
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      validationEnv?.cleanup();

      const stdoutOutput = renderCapturedCommandOutput("stdout", stdout);
      const stderrOutput = renderCapturedCommandOutput("stderr", stderr);

      if (code === 0 && !timedOut && !spawnError) {
        resolve({ ok: true, output: stdoutOutput });
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      const fallbackOutput = timedOut
        ? `Command timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`
        : signal
          ? `Command exited with signal ${signal}.`
          : `Command exited with code ${code ?? "unknown"}.`;
      const rawOutput = joinFailureSections(
        stderrOutput,
        stdoutOutput,
        spawnError ? spawnError.message : undefined,
      ) ?? fallbackOutput;
      const annotatedOutput = buildCommandFailureOutput({
        output: rawOutput,
        elapsedMs,
        timedOut,
        timeoutMs,
      });
      const logResult = writeValidationCommandLog({
        rootDir: PRODUCTION_ROOT,
        source: "staging",
        command: cmd,
        cwd,
        output: annotatedOutput,
        elapsedMs,
        timedOut,
        timeoutMs,
      });
      resolve({
        ok: false,
        output: buildCommandFailureOutput({
          output: rawOutput,
          elapsedMs,
          timedOut,
          timeoutMs,
          logPath: logResult.path,
          logWriteError: logResult.error,
        }),
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killProcessTree(child.pid);
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      appendCapturedCommandOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendCapturedCommandOutput(stderr, chunk);
    });
    child.on("error", (err) => {
      spawnError = err;
      finish(null, null);
    });
    child.on("close", finish);
  });
}

function normalizeFailureText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function truncateFailureText(text: string | undefined, maxChars: number): string | undefined {
  const normalized = normalizeFailureText(text);
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `…${normalized.slice(-maxChars)}`;
}

function joinFailureSections(...sections: Array<string | undefined>): string | undefined {
  const present = sections
    .map((section) => normalizeFailureText(section))
    .filter((section): section is string => Boolean(section));
  return present.length > 0 ? present.join("\n\n") : undefined;
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

type PruneOrphanedWorktreesOptions = {
  stagingParent?: string;
  stagingDistParent?: string;
  stagingPreviewParents?: string[];
  activePreviewMap?: Map<string, string>;
  expressApp?: express.Application | null;
  listBranchPrefixes?: () => Set<string> | null | Promise<Set<string> | null>;
  removeWorktree?: (stagingDir: string, branch: string) => void | Promise<void>;
  restoreBackend?: (
    prefix: string,
    stagingDir: string,
    options?: RestoreStagingBackendWithRetryOptions,
  ) => Promise<{ restored: boolean; attempts: number; error?: string }>;
  log?: (msg: string) => void;
  pruneGitWorktrees?: () => void | Promise<void>;
};

/**
 * Prune orphaned staging worktrees on server startup and restore surviving previews.
 * Called from server initialization — removes worktrees whose branches
 * no longer exist, and fully restores (frontend + backend) previews that survived a restart.
 */
async function pruneOrphanedWorktreesImpl(options: PruneOrphanedWorktreesOptions = {}): Promise<void> {
  const writeLog = options.log ?? log;
  if (!shouldManageStagingArtifacts()) {
    writeLog("Demo mode — skipping staging worktree pruning and preview restore");
    return;
  }

  const stagingParent = options.stagingParent ?? STAGING_PARENT;
  const stagingPreviewParents = options.stagingPreviewParents
    ?? (options.stagingDistParent ? [options.stagingDistParent] : listStagingPreviewParents());
  const previewMap = options.activePreviewMap ?? activePreviews;
  const expressApp = options.expressApp ?? _expressApp;
  const getBranchPrefixes = options.listBranchPrefixes ?? listStagingBranchPrefixes;
  const removeOrphanedWorktree = options.removeWorktree ?? removeWorktree;
  const restoreBackend = options.restoreBackend ?? restoreStagingBackendWithRetry;
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
            previewMap.set(entry.name, distDir);
            restorablePreviews.set(entry.name, {
              ...createPreviewTarget(join(stagingParent, parsed.stagingName), parsed.profile),
              outDir: distDir,
            });
            restoredPreviewDirs++;
          }
        } else if (!skipOrphanPrune) {
          rmSync(join(stagingPreviewParent, entry.name), { recursive: true, force: true });
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
        `${restoredPreviewDirs} preview dir(s) restored, ` +
        `${orphanedWorktreeDirs} orphan worktree dir(s) removed, ` +
        `${orphanedPreviewDirs} orphan preview dir(s) removed`,
    );
  }

  if (skipOrphanPrune) {
    writeLog("Skipping orphan staging prune because the staging branch snapshot is unavailable");
  }

  // Restore staged backends for surviving previews
  if (expressApp) {
    for (const target of restorablePreviews.values()) {
      if (!previewMap.has(target.prefix)) continue;
      writeLog(`Restoring staged backend for preview: ${target.prefix}`);
      const restoreResult = await restoreBackend(target.prefix, target.stagingDir, { profile: target.profile });
      if (restoreResult.restored) {
        writeLog(`Restored staged backend for preview: ${target.prefix}`);
      } else {
        writeLog(
          `Failed to restore staged backend for ${target.prefix} after ${restoreResult.attempts} attempts: ` +
            `${restoreResult.error}. Cleaning up preview.`,
        );
        await cleanupPreviewTarget(target.stagingDir, target.profile);
      }
    }
  }
}

export async function pruneOrphanedWorktrees(): Promise<void> {
  await pruneOrphanedWorktreesImpl();
}

export const __testing = {
  seedStagingData(stagingDir: string, options: SeedStagingDataOptions = {}) {
    return seedStagingData(stagingDir, options).dataDir;
  },
  createStagingContext,
  restoreStagingBackendWithRetry,
  listStagingBranchPrefixes,
  pruneOrphanedWorktreesImpl,
  getStagingPreviewParent: () => STAGING_PREVIEW_PARENT,
  listStagingPreviewParents,
};

export const STAGING_TOOLS = [
  defineTool("staging_init", {
    description:
      "Create a fresh staging worktree for making code changes to the bridge. " +
      "Returns the staging directory path where you should make all edits. " +
      "Run quality checks (npx tsc --noEmit, npm run test:xplat-audit, npx vite build, npx vitest run) in that directory before calling staging_deploy.",
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
        profile: {
          type: "string",
          enum: ["clone", "demo"],
          description: "Preview data profile. 'clone' copies production-like data; 'demo' seeds the curated demo workspace. Defaults to 'clone'.",
        },
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
        const validationResult = await runValidationGateAsync(PREVIEW_GATE, {
          cwd: stagingDir,
          run: (command, options) => run(command, stagingDir, options),
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

      // ── Staged backend ──────────────────────────────────────────
      let backendReady = false;
      let backendError: string | undefined;

      if (_expressApp) {
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
          ? `${profile === "demo" ? "Demo" : "Staging"} preview is live at ${fullUrl} (also available locally at ${localUrl}) — share this link with the user and wait for confirmation before deploying.`
          : `${profile === "demo" ? "Demo" : "Staging"} preview is live locally at ${localUrl} — share this link with the user and wait for confirmation before deploying.`) + backendNote,
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

      const validationResult = await runValidationGateAsync(DEPLOY_GATE, {
        cwd: stagingDir,
        run: (command, options) => run(command, stagingDir, options),
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

      await unstashProduction();

      // Signal launcher to restart
      const dataDir = join(PRODUCTION_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      triggerRestartPending();
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      log("Restart signal sent");

      // Cleanup staging worktree and branch (best-effort — deploy already succeeded)
      try {
        await cleanupPreviewArtifactsForStagingDir(stagingDir);
        await removeWorktree(stagingDir, branch);
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

      await cleanupPreviewArtifactsForStagingDir(stagingDir);
      await removeWorktree(stagingDir, branch);

      log("Staging worktree cleaned up");
      return { success: true, message: `Staging worktree removed: ${stagingDir}` };
    },
  }),
];
