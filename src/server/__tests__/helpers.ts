// Shared test helpers — SQLite in-memory database setup

import express from "express";
import { mkdtempSync } from "node:fs";
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
import { createSessionTitlesStore } from "../session-titles.js";
import { createReadStateStore } from "../read-state-store.js";
import { createChecklistStore } from "../checklist-store.js";
import { createTagStore } from "../tag-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createVoiceJobStore } from "../voice-job-store.js";
import { createVoiceJobManager } from "../voice-job-manager.js";
import { createDocsStore } from "../docs-store.js";
import { createDocsIndex } from "../docs-index.js";
import { createApiRouter } from "../api-router.js";
import type { AppContext } from "../app-context.js";
import type { TranscriptionService } from "../transcription-service.js";

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
    listSessionsFromDisk: () => [],
    getSessionActivity: () => [],
    isSessionBusy: () => false,
    getSessionRunState: () => "idle",
    isSessionWarm: () => false,
    createSession: async () => ({ sessionId: "test-session" }),
    duplicateSession: async () => ({ sessionId: "dup-session" }),
    startWork: () => {},
    startFleet: () => {},
    abortSession: async () => true,
    getSessionMessages: async () => ({ messages: [], total: 0, hasMore: false }),
    readMessagesFromDisk: () => ({ messages: [], total: 0, hasMore: false }),
    warmSession: async () => {},
    reloadSession: async () => [],
    deleteSession: async () => {},
    gracefulShutdown: async () => {},
    evictAllCachedSessions: () => {},
    getMcpStatus: async () => [],
    getLatestMcpStatus: () => [],
    hasPlan: () => true,
    createTaskSession: async () => ({ sessionId: "task-session" }),
    invalidateSessionListCache: () => {},
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
  const runtimePaths = overrides?.runtimePaths;
  const dataDir = runtimePaths?.dataDir ?? mkdtempSync(join(tmpdir(), "bridge-test-data-"));

  const docsDir = runtimePaths?.docsDir ?? mkdtempSync(join(tmpdir(), "bridge-test-docs-"));
  const docsStore = createDocsStore(docsDir);
  const docsIndex = createDocsIndex(db, docsStore);
  const transcriptionService = createMockTranscriptionService();
  const sessionManager = createMockSessionManager();
  const taskStore = overrides?.taskStore ?? createTaskStore(db, globalBus, runtimePaths ? { runtimePaths } : undefined);
  const taskGroupStore = createTaskGroupStore(db);

  const baseContext: Omit<AppContext, "voiceJobManager"> = {
    taskStore,
    taskGroupStore,
    scheduleStore: createScheduleStore(db),
    settingsStore: createSettingsStore(db),
    sessionMetaStore: createSessionMetaStore(db),
    sessionTitles: createSessionTitlesStore(db),
    readStateStore: createReadStateStore(db),
     checklistStore: createChecklistStore(db, globalBus),
    tagStore: createTagStore(db),
    telemetryStore: createTelemetryStore(db),
    docsStore,
    docsIndex,
    globalBus,
    eventBusRegistry,
    sessionManager,
    transcriptionService,
    apiBasePath: "/api",
    ...(runtimePaths ? { runtimePaths } : {}),
    launcherLogPath: undefined,
  };
  const ctx = {
    ...baseContext,
    ...overrides,
  } as AppContext;
  ctx.voiceJobManager ??= createVoiceJobManager({
    dataDir,
    store: createVoiceJobStore(db),
    transcriptionService: ctx.transcriptionService,
    sessionManager: ctx.sessionManager,
    taskStore: ctx.taskStore,
    taskGroupStore: ctx.taskGroupStore,
  });

  const app = express();
  app.use("/api", createApiRouter(ctx));

  return { app, ctx, db };
}
