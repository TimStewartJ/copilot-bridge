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
import { createTodoStore } from "../todo-store.js";
import { createTagStore } from "../tag-store.js";
import { createDocsStore } from "../docs-store.js";
import { createDocsIndex } from "../docs-index.js";
import { createApiRouter } from "../api-router.js";
import type { AppContext } from "../app-context.js";

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
    getSessionActivity: () => [],
    isSessionBusy: () => false,
    createSession: async () => ({ sessionId: "test-session" }),
    duplicateSession: async () => ({ sessionId: "dup-session" }),
    startWork: () => {},
    abortSession: async () => true,
    getSessionMessages: async () => ({ messages: [], total: 0, hasMore: false }),
    deleteSession: async () => {},
    gracefulShutdown: async () => {},
    evictAllCachedSessions: () => {},
    getMcpStatus: async () => [],
    getLatestMcpStatus: () => [],
    createTaskSession: async () => ({ sessionId: "task-session" }),
  } as any;
}

/**
 * Create a fully wired Express app for integration testing.
 * Uses in-memory SQLite, real stores (including docs), and a mock session manager.
 * Returns the app, AppContext, and db for direct access in assertions.
 */
export function createTestApp(overrides?: Partial<AppContext>) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();

  const docsDir = mkdtempSync(join(tmpdir(), "bridge-test-docs-"));
  const docsStore = createDocsStore(docsDir);
  const docsIndex = createDocsIndex(db, docsStore);

  const ctx: AppContext = {
    taskStore: createTaskStore(db, globalBus),
    taskGroupStore: createTaskGroupStore(db),
    scheduleStore: createScheduleStore(db),
    settingsStore: createSettingsStore(db),
    sessionMetaStore: createSessionMetaStore(db),
    sessionTitles: createSessionTitlesStore(db),
    readStateStore: createReadStateStore(db),
    todoStore: createTodoStore(db, globalBus),
    tagStore: createTagStore(db),
    docsStore,
    docsIndex,
    globalBus,
    eventBusRegistry,
    sessionManager: createMockSessionManager(),
    ...overrides,
  };

  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use("/api", createApiRouter(ctx));

  return { app, ctx, db };
}
