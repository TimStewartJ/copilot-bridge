// Heavy integration fixture — fully wired Express app + AppContext.
//
// Split out of ./helpers.ts on purpose: `createApiRouter` drags ~180 modules
// (~2 MB of source) into whatever imports it, and Vitest re-evaluates that graph
// for every isolated test file. Only files that actually mount HTTP routes
// should import from here; everything else uses ./helpers.ts.

import express from "express";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
import { createFeedStore } from "../feed-store.js";
import { createTagStore } from "../tag-store.js";
import { createMcpServerStore } from "../mcp-server-store.js";
import { createCopilotModelPriceStore } from "../copilot-model-price-store.js";
import { createCopilotUsageStore } from "../copilot-usage-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createSessionContextStore } from "../session-context-store.js";
import { createVoiceJobStore } from "../voice-job-store.js";
import { createPushNotificationService } from "../push-notification-service.js";
import { createPushSubscriptionStore } from "../push-subscription-store.js";
import { createVoiceJobManager } from "../voice-job-manager.js";
import { createDocsStore } from "../docs-store.js";
import { createDocsIndex } from "../docs-index.js";
import { createDocsSnapshotStore } from "../docs-snapshot-store.js";
import { createApiRouter, type ApiRouterOptions } from "../api-router.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import type { AppContext } from "../app-context.js";
import { resolveRuntimePaths } from "../runtime-paths.js";
import { deleteVisualArtifactForOwner, feedCardVisualOwner } from "../visual-artifacts.js";
import {
  createHermeticEnv,
  createMockSessionManager,
  createMockTranscriptionService,
  makeTestDir,
  makeTestRuntimePaths,
  registerTestAppCleanup,
  setupTestDb,
  createTestBus,
  throwCleanupErrors,
} from "./helpers.js";

function hasNoArgFunction<K extends string>(value: unknown, method: K): value is Record<K, () => unknown> {
  return typeof value === "object"
    && value !== null
    && typeof (value as Record<K, unknown>)[method] === "function";
}

/**
 * Create a fully wired Express app for integration testing.
 * Uses in-memory SQLite, real stores (including docs), and a mock session manager.
 * Returns the app, AppContext, and db for direct access in assertions.
 */
export function createTestApp(overrides?: Partial<AppContext>, routerOptions: ApiRouterOptions = {}) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const baseRuntimePaths = overrides?.runtimePaths ?? makeTestRuntimePaths("app", { copilotHome: overrides?.copilotHome });
  const copilotHome = overrides?.copilotHome ?? baseRuntimePaths.copilotHome ?? join(makeTestDir("copilot-home"), ".copilot");
  mkdirSync(copilotHome, { recursive: true });
  const runtimePaths = resolveRuntimePaths(createHermeticEnv(baseRuntimePaths.env), {
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
    feedStore: createFeedStore(db, globalBus, {
      onVisualUnreferenced: (visual, card) => {
        const result = deleteVisualArtifactForOwner(copilotHome, feedCardVisualOwner(card.id), visual.artifactId);
        if (!result.ok) console.warn(`[test-feed] Failed to delete unreferenced visual ${visual.artifactId}: ${result.error}`);
      },
    }),
    tagStore: createTagStore(db),
    mcpServerStore: createMcpServerStore(db),
    copilotModelPriceStore: createCopilotModelPriceStore(db),
    copilotUsageStore: createCopilotUsageStore(db),
    telemetryStore: createTelemetryStore(db),
    sessionContextStore: createSessionContextStore(db),
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
  app.use("/api", createApiRouter(ctx, routerOptions));

  const cleanup = registerTestAppCleanup(async () => {
    const cleanupErrors: unknown[] = [];
    if (hasNoArgFunction(ctx.copilotUsageReader, "shutdown")) {
      try {
        await ctx.copilotUsageReader.shutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
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
