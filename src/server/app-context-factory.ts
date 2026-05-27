import { join } from "node:path";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { setMcpServersGetter } from "./config.js";
import { openDatabase } from "./db.js";
import { createTaskStore } from "./task-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createSessionMetaStore } from "./session-meta-store.js";
import { createSessionWorkspaceStore } from "./session-workspace-store.js";
import { createSettingsStore } from "./settings-store.js";
import { createSessionTitlesStore } from "./session-titles.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";
import { createCopilotCliSessionCatalog } from "./copilot-cli-session-catalog.js";
import { createScheduleStore } from "./schedule-store.js";
import { createReadStateStore } from "./read-state-store.js";
import { createChecklistStore } from "./checklist-store.js";
import { createFeedStore } from "./feed-store.js";
import { createDocsStore } from "./docs-store.js";
import { createDocsIndex } from "./docs-index.js";
import { createDocsSnapshotStore, STARTUP_SNAPSHOT_MIN_INTERVAL_MS } from "./docs-snapshot-store.js";
import { createTagStore } from "./tag-store.js";
import { createMcpServerStore } from "./mcp-server-store.js";
import { createTelemetryStore } from "./telemetry-store.js";
import { createVoiceJobStore } from "./voice-job-store.js";
import { createPushNotificationService, initPushEventNotifications } from "./push-notification-service.js";
import { createPushSubscriptionStore } from "./push-subscription-store.js";
import * as scheduler from "./scheduler.js";
import { defaultEventBusRegistry } from "./event-bus.js";
import { defaultGlobalBus } from "./global-bus.js";
import type { AppContext } from "./app-context.js";
import { createTranscriptionService } from "./transcription-service.js";
import { createVoiceJobManager } from "./voice-job-manager.js";
import type { RuntimePaths } from "./runtime-paths.js";
import { createDeferredPromptStore } from "./deferred-prompt-store.js";
import { createDeferredPromptRunner } from "./deferred-prompt-runner.js";
import { createDeferLoopStore } from "./defer-loop-store.js";
import { createDeferLoopRunner } from "./defer-loop-runner.js";
import { createDeferDeliveryGuard } from "./defer-delivery-guard.js";
import { createSessionManager } from "./session-manager.js";
import { deleteVisualArtifactForOwner, feedCardVisualOwner } from "./visual-artifacts.js";
import {
  BridgeToolsMcpServer,
  buildBridgeToolsMcpServerConfig,
  createBridgeToolsMcpEndpoint,
  registerAllBridgeTools,
} from "./agent-tools-mcp/index.js";

export interface CreateAppContextOptions {
  runtimePaths: RuntimePaths;
  apiBasePath: string;
  launcherLogPath?: string;
  isStaging?: boolean;
  sessionModel?: string;
  excludedToolNames?: Iterable<string>;
  enableStartupDocsSnapshot?: boolean;
}

export interface CreatedAppContext {
  ctx: AppContext;
  db: DatabaseSync;
}

export function createAppContext(options: CreateAppContextOptions): CreatedAppContext {
  const { runtimePaths } = options;
  Object.assign(process.env, runtimePaths.env);

  const dataDir = runtimePaths.dataDir;
  const db = openDatabase(dataDir);
  const taskStore = createTaskStore(db, defaultGlobalBus, { runtimePaths });
  const taskGroupStore = createTaskGroupStore(db);
  const scheduleStore = createScheduleStore(db);
  const settingsStore = createSettingsStore(db);
  const sessionMetaStore = createSessionMetaStore(db);
  const sessionWorkspaceStore = createSessionWorkspaceStore(db);
  const sessionTitles = createSessionTitlesStore(db);
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);
  const readStateStore = createReadStateStore(db);
  const checklistStore = createChecklistStore(db, defaultGlobalBus);
  const feedStore = createFeedStore(db, defaultGlobalBus, {
    onVisualUnreferenced: (visual, card) => {
      const result = deleteVisualArtifactForOwner(
        runtimePaths.copilotHome ?? join(homedir(), ".copilot"),
        feedCardVisualOwner(card.id),
        visual.artifactId,
      );
      if (!result.ok) {
        console.warn(`[feed] Failed to delete unreferenced visual ${visual.artifactId}: ${result.error}`);
      }
    },
  });
  const tagStore = createTagStore(db);
  const mcpServerStore = createMcpServerStore(db);
  const telemetryStore = createTelemetryStore(db);
  const cliSessionCatalog = createCopilotCliSessionCatalog({
    copilotHome: runtimePaths.copilotHome,
    recordSpan: (name, duration, sessionId, metadata) =>
      telemetryStore.recordSpan({ name, duration, sessionId, metadata, source: "server" }),
  });
  const voiceJobStore = createVoiceJobStore(db);
  const pushSubscriptionStore = createPushSubscriptionStore(db);
  const docsStore = createDocsStore(runtimePaths.docsDir);
  const docsIndex = createDocsIndex(db, docsStore);
  const docsSnapshotStore = createDocsSnapshotStore(
    runtimePaths.docsDir,
    runtimePaths.docsSnapshotsDir ?? join(dataDir, "backups", "docs", "snapshots"),
  );
  docsIndex.reindex();
  if (options.enableStartupDocsSnapshot) {
    try {
      docsSnapshotStore.createSnapshot({
        reason: "startup",
        allowEmpty: false,
        skipIfRecentMs: STARTUP_SNAPSHOT_MIN_INTERVAL_MS,
        skipIfUnchanged: true,
      });
    } catch (error) {
      console.warn(`[docs-snapshots] Startup snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const deferredPromptStore = createDeferredPromptStore(db);
  const deferLoopStore = createDeferLoopStore(db);
  const deferDeliveryGuard = createDeferDeliveryGuard();
  const copilotHome = runtimePaths.copilotHome;

  setMcpServersGetter(() => settingsStore.getMcpServers());

  const ctx: AppContext = {
    taskStore,
    taskGroupStore,
    scheduleStore,
    settingsStore,
    sessionMetaStore,
    sessionWorkspaceStore,
    sessionTitles,
    bridgeSessionStateStore,
    cliSessionCatalog,
    readStateStore,
    checklistStore,
    feedStore,
    docsStore,
    docsIndex,
    docsSnapshotStore,
    tagStore,
    mcpServerStore,
    telemetryStore,
    globalBus: defaultGlobalBus,
    eventBusRegistry: defaultEventBusRegistry,
    sessionManager: null as any,
    transcriptionService: createTranscriptionService(),
    voiceJobManager: null as any,
    pushSubscriptionStore,
    deferredPromptStore,
    deferLoopStore,
    scheduler,
    copilotHome,
    apiBasePath: options.apiBasePath,
    runtimePaths,
    launcherLogPath: options.launcherLogPath,
    isStaging: options.isStaging,
  };

  const excludedToolNames = new Set(options.excludedToolNames ?? []);
  const bridgeToolsMcpServer = new BridgeToolsMcpServer(ctx, {
    onError: (error) => {
      console.warn("[bridge-tools-mcp]", error.message);
    },
  });
  registerAllBridgeTools(bridgeToolsMcpServer, ctx, { excludedToolNames });
  const bridgeToolsMcpEndpoint = createBridgeToolsMcpEndpoint({ dataDir });
  const bridgeToolsMcpConfig = buildBridgeToolsMcpServerConfig({
    endpoint: bridgeToolsMcpEndpoint,
    toolNames: bridgeToolsMcpServer.getToolNames("global"),
    distributionMode: runtimePaths.distributionMode,
  });
  ctx.bridgeToolsMcpServer = bridgeToolsMcpServer;
  ctx.bridgeToolsMcpConfig = bridgeToolsMcpConfig;
  ctx.bridgeToolsMcpEndpoint = bridgeToolsMcpEndpoint;

  const sessionManager = createSessionManager(ctx, {
    config: {
      get sessionMcpServers() {
        return settingsStore.getMcpServers();
      },
      ...(options.sessionModel ? { model: options.sessionModel } : {}),
    },
    ...(bridgeToolsMcpConfig ? { builtInMcpServers: { [bridgeToolsMcpConfig.name]: bridgeToolsMcpConfig.config } } : {}),
    ...(copilotHome ? { copilotHome } : {}),
    runtimePaths,
  });
  ctx.sessionManager = sessionManager;
  ctx.voiceJobManager = createVoiceJobManager({
    dataDir,
    store: voiceJobStore,
    transcriptionService: ctx.transcriptionService,
    sessionManager,
    taskStore,
    taskGroupStore,
  });
  ctx.pushNotificationService = createPushNotificationService({
    subscriptionStore: pushSubscriptionStore,
    env: runtimePaths.env,
  });
  initPushEventNotifications(ctx, ctx.pushNotificationService);
  ctx.deferredPromptRunner = createDeferredPromptRunner(
    deferredPromptStore,
    sessionManager,
    defaultGlobalBus,
    deferDeliveryGuard,
    { deferredPromptStore, deferLoopStore },
  );
  ctx.deferLoopRunner = createDeferLoopRunner(
    deferLoopStore,
    sessionManager,
    defaultGlobalBus,
    deferDeliveryGuard,
    { deferredPromptStore, deferLoopStore },
  );

  return { ctx, db };
}

export async function startBridgeToolsMcpServer(ctx: AppContext): Promise<void> {
  if (!ctx.bridgeToolsMcpServer || !ctx.bridgeToolsMcpConfig || !ctx.bridgeToolsMcpEndpoint) return;
  await ctx.bridgeToolsMcpServer.listen(ctx.bridgeToolsMcpEndpoint);
}

export function initializeSchedulerAndDeferredRunners(ctx: AppContext): void {
  ctx.scheduler?.initialize(ctx.sessionManager, {
    scheduleStore: ctx.scheduleStore,
    taskStore: ctx.taskStore,
    sessionMetaStore: ctx.sessionMetaStore,
    globalBus: ctx.globalBus,
    deferredPromptStore: ctx.deferredPromptStore,
    deferLoopStore: ctx.deferLoopStore,
  });
  ctx.deferredPromptRunner?.start();
  ctx.deferLoopRunner?.start();
}

export async function shutdownAppContextServices(ctx: AppContext): Promise<void> {
  ctx.deferredPromptRunner?.shutdown();
  ctx.deferLoopRunner?.shutdown();
  ctx.scheduler?.shutdown();
  await ctx.voiceJobManager.shutdown();
  await ctx.sessionManager.gracefulShutdown();
  await ctx.bridgeToolsMcpServer?.close();
}
