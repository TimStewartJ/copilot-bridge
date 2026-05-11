// Shared test helpers — SQLite in-memory database setup

import express from "express";
import { afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDatabase } from "../db.js";
import type { DatabaseSync } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createTaskStore } from "../task-store.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createScheduleStore } from "../schedule-store.js";
import { createSettingsStore } from "../settings-store.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createSessionWorkspaceStore } from "../session-workspace-store.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";
import { createCopilotCliSessionCatalog } from "../copilot-cli-session-catalog.js";
import { createReadStateStore } from "../read-state-store.js";
import { createChecklistStore } from "../checklist-store.js";
import { createTagStore } from "../tag-store.js";
import { createMcpServerStore } from "../mcp-server-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createVoiceJobStore } from "../voice-job-store.js";
import { createPushNotificationService } from "../push-notification-service.js";
import { createPushSubscriptionStore } from "../push-subscription-store.js";
import { createVoiceJobManager } from "../voice-job-manager.js";
import { createDocsStore } from "../docs-store.js";
import { createDocsIndex } from "../docs-index.js";
import { createDocsSnapshotStore } from "../docs-snapshot-store.js";
import { createApiRouter } from "../api-router.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import type { AppContext } from "../app-context.js";
import { resolveRuntimePaths } from "../runtime-paths.js";
import type { RuntimePathOverrides, RuntimePaths } from "../runtime-paths.js";
import type { TranscriptionService } from "../transcription-service.js";

const TEST_RUNTIME_ENV_KEYS = ["BRIDGE_DEMO_MODE", "BRIDGE_DATA_DIR", "BRIDGE_DOCS_DIR", "BRIDGE_DOCS_SNAPSHOTS_DIR", "COPILOT_HOME"] as const;
const TEST_CLEANUP_MAX_RETRIES = 20;
const TEST_CLEANUP_RETRY_DELAY_MS = 50;
const testCleanupPaths = new Set<string>();
const testAppCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  const cleanupErrors: unknown[] = [];

  for (const cleanup of [...testAppCleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  testAppCleanups.clear();

  vi.unstubAllEnvs();
  const cleanupPaths = [...testCleanupPaths].sort((a, b) => b.length - a.length);
  testCleanupPaths.clear();
  for (const dir of cleanupPaths) {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: TEST_CLEANUP_MAX_RETRIES,
        retryDelay: TEST_CLEANUP_RETRY_DELAY_MS,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  throwCleanupErrors(cleanupErrors, "Test cleanup failed");
});

function sanitizeTestPrefix(prefix: string): string {
  return prefix.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "test";
}

function createHermeticEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of TEST_RUNTIME_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export function makeTestDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bridge-${sanitizeTestPrefix(prefix)}-`));
  testCleanupPaths.add(dir);
  return dir;
}

function registerTestAppCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let cleanedUp = false;
  const trackedCleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    testAppCleanups.delete(trackedCleanup);
    await cleanup();
  };
  testAppCleanups.add(trackedCleanup);
  return trackedCleanup;
}

function hasNoArgFunction<K extends string>(value: unknown, method: K): value is Record<K, () => unknown> {
  return typeof value === "object"
    && value !== null
    && typeof (value as Record<K, unknown>)[method] === "function";
}

function throwCleanupErrors(cleanupErrors: unknown[], message: string): void {
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, message);
  }
}

export function makeTestRuntimePaths(
  prefix: string,
  overrides: RuntimePathOverrides = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
  const rootDir = makeTestDir(prefix);
  const demoMode = overrides.demoMode ?? false;
  const dataDir = overrides.dataDir ?? join(rootDir, "data");
  const docsDir = overrides.docsDir ?? join(rootDir, "docs");
  const docsSnapshotsDir = overrides.docsSnapshotsDir ?? join(rootDir, "docs-snapshots");
  const copilotHome = overrides.copilotHome ?? join(rootDir, ".copilot");
  const workspaceDir = overrides.workspaceDir ?? (demoMode ? join(rootDir, "workspace") : undefined);

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(docsSnapshotsDir, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  if (workspaceDir) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  return resolveRuntimePaths(createHermeticEnv(baseEnv), {
    ...overrides,
    demoMode,
    dataDir,
    docsDir,
    docsSnapshotsDir,
    copilotHome,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

export async function withTestEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T | Promise<T>,
): Promise<T> {
  const keys = new Set<string>([...TEST_RUNTIME_ENV_KEYS, ...Object.keys(overrides)]);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Create an in-memory SQLite database with schema initialized.
 * Returns the database instance. No cleanup needed — GC handles it.
 */
export function setupTestDb(): DatabaseSync {
  return openMemoryDatabase();
}

/** Create a test global bus (no-op emitter) */
export function createTestBus() {
  return createGlobalBus();
}

/** Minimal mock SessionManager for API route tests */
export function createMockSessionManager() {
  return {
    listSessions: async () => [],
    listModels: async () => [],
    listSessionsFromDisk: () => [],
    getSessionActivity: () => [],
    isSessionBusy: () => false,
    getSessionRunState: () => "idle",
    getPendingUserInputCount: () => 0,
    isSessionWarm: () => false,
    createSession: async () => ({ sessionId: "test-session" }),
    forkSession: async () => ({ sessionId: "fork-session" }),
    setSessionName: async () => {},
    startWork: () => {},
    startFleet: () => {},
    abortSession: async () => true,
    getSessionMessages: async () => ({ messages: [], total: 0, hasMore: false }),
    readMessagesFromDisk: () => ({ messages: [], total: 0, hasMore: false }),
    warmSession: async () => {},
    reloadSession: async () => [],
    submitUserInputResponse: async (_sessionId: string, requestId: string, payload: any) => ({
      requestId,
      answer: payload?.answer,
      wasFreeform: payload?.wasFreeform,
      timestamp: "2026-04-29T12:00:00.000Z",
    }),
    deleteSession: async () => {},
    gracefulShutdown: async () => {},
    evictAllCachedSessions: () => {},
    setSessionModel: async (_id: string, model: string, reasoningEffort?: string) => ({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }),
    getSessionModelState: async () => ({ source: "unknown" as const }),
    getMcpStatus: async () => [],
    loginMcpServer: async (_sessionId: string, serverName: string) => ({
      serverName,
      authorizationUrl: "https://login.example.test",
      servers: [{ name: serverName, status: "pending" }],
    }),
    getLatestMcpStatus: () => [],
    hasPlan: () => true,
    createTaskSession: async () => ({ sessionId: "task-session" }),
    invalidateSessionListCache: () => {},
    setSessionWorkspace: (sessionId: string, cwd: string) => ({
      cwd,
      source: "explicit",
      message: `Session workspace set to ${cwd} for future turns`,
      sessionId,
    }),
    resetSessionWorkspace: (_sessionId: string) => ({
      cwd: "",
      source: "task-default",
      message: "Session workspace reset to linked task default",
    }),
  } as any;
}
export function createMockTranscriptionService(overrides?: Partial<TranscriptionService>): TranscriptionService {
  return {
    getStatus: () => ({
      available: false,
      provider: "disabled",
      label: "Unavailable",
      reason: "Voice input is not configured on the server.",
      maxDurationSeconds: 120,
    }),
    transcribe: async () => {
      throw new Error("Voice input is not configured on the server.");
    },
    ...overrides,
  };
}

/** Shared cross-platform test helpers */
export {
  isWindows,
  normalizePath,
  pathBasename,
  pathSegments,
  testCopilotHome,
  testExecutablePath,
  testPath,
} from "./test-paths.js";

/**
 * Create a fully wired Express app for integration testing.
 * Uses in-memory SQLite, real stores (including docs), and a mock session manager.
 * Returns the app, AppContext, and db for direct access in assertions.
 */
export function createTestApp(overrides?: Partial<AppContext>) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const baseRuntimePaths = overrides?.runtimePaths ?? makeTestRuntimePaths("app", { copilotHome: overrides?.copilotHome });
  const copilotHome = overrides?.copilotHome ?? baseRuntimePaths.copilotHome ?? join(makeTestDir("copilot-home"), ".copilot");
  mkdirSync(copilotHome, { recursive: true });
  const runtimePaths = resolveRuntimePaths(createHermeticEnv(baseRuntimePaths.env), {
    demoMode: baseRuntimePaths.demoMode,
    dataDir: baseRuntimePaths.dataDir,
    docsDir: baseRuntimePaths.docsDir,
    docsSnapshotsDir: baseRuntimePaths.docsSnapshotsDir,
    copilotHome,
    workspaceDir: baseRuntimePaths.workspaceDir,
  });
  const docsStore = createDocsStore(runtimePaths.docsDir);
  const docsIndex = createDocsIndex(db, docsStore);
  const docsSnapshotStore = createDocsSnapshotStore(
    runtimePaths.docsDir,
    runtimePaths.docsSnapshotsDir ?? join(runtimePaths.dataDir, "backups", "docs", "snapshots"),
  );
  const transcriptionService = createMockTranscriptionService();
  const sessionManager = createMockSessionManager();
  const taskStore = overrides?.taskStore ?? createTaskStore(db, globalBus, { runtimePaths });
  const taskGroupStore = createTaskGroupStore(db);
  const pushSubscriptionStore = createPushSubscriptionStore(db);

  const baseContext: Omit<AppContext, "voiceJobManager"> = {
    taskStore,
    taskGroupStore,
    scheduleStore: createScheduleStore(db),
    settingsStore: createSettingsStore(db),
    sessionMetaStore: createSessionMetaStore(db),
    sessionWorkspaceStore: createSessionWorkspaceStore(db),
    sessionTitles: createSessionTitlesStore(db),
    bridgeSessionStateStore: createBridgeSessionStateStore(db),
    cliSessionCatalog: createCopilotCliSessionCatalog({ copilotHome: runtimePaths.copilotHome }),
    readStateStore: createReadStateStore(db),
    checklistStore: createChecklistStore(db, globalBus),
    tagStore: createTagStore(db),
    mcpServerStore: createMcpServerStore(db),
    telemetryStore: createTelemetryStore(db),
    docsStore,
    docsIndex,
    docsSnapshotStore,
    globalBus,
    eventBusRegistry,
    sessionManager,
    transcriptionService,
    pushSubscriptionStore,
    pushNotificationService: createPushNotificationService({ subscriptionStore: pushSubscriptionStore }),
    deferredPromptStore: createDeferredPromptStore(db),
    deferLoopStore: createDeferLoopStore(db),
    copilotHome,
    apiBasePath: "/api",
    runtimePaths,
    launcherLogPath: undefined,
  };
  const ctx = {
    ...baseContext,
    ...overrides,
  } as AppContext;
  ctx.runtimePaths = runtimePaths;
  ctx.copilotHome ??= copilotHome;
  ctx.voiceJobManager ??= createVoiceJobManager({
    dataDir: runtimePaths.dataDir,
    store: createVoiceJobStore(db),
    transcriptionService: ctx.transcriptionService,
    sessionManager: ctx.sessionManager,
    taskStore: ctx.taskStore,
    taskGroupStore: ctx.taskGroupStore,
  });

  const app = express();
  app.use("/api", createApiRouter(ctx));

  const cleanup = registerTestAppCleanup(async () => {
    const cleanupErrors: unknown[] = [];
    if (hasNoArgFunction(ctx.voiceJobManager, "shutdown")) {
      try {
        await ctx.voiceJobManager.shutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (hasNoArgFunction(ctx.sessionManager, "gracefulShutdown")) {
      try {
        await ctx.sessionManager.gracefulShutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      db.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwCleanupErrors(cleanupErrors, "Test app cleanup failed");
  });

  return { app, ctx, db, cleanup };
}
