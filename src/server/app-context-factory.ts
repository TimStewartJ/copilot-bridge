import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import { createTaskStore } from "./task-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createSessionMetaStore } from "./session-meta-store.js";
import { createSessionWorkspaceStore } from "./session-workspace-store.js";
import { createSessionPlaybookStore } from "./session-playbook-store.js";
import { createSkillCatalog } from "./skill-catalog.js";
import { createSkillPackManager } from "./skill-packs.js";
import { createSkillUsageStore } from "./skill-usage-store.js";
import { CuaDriverInstaller } from "./cua-driver.js";
import { createTaskStartersStore } from "./task-starters-store.js";
import { createUnattendedRunStore } from "./unattended-run-store.js";
import { createTaskHistoryStore } from "./task-history-store.js";
import { createCompletionReportStore } from "./completion-report-store.js";
import { createTaskPageStore } from "./task-page-store.js";
import { createSettingsStore } from "./settings-store.js";
import { createSessionTitlesStore } from "./session-titles.js";
import { parseWorkspaceYamlSessionName } from "./session-workspace-yaml.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";
import { createCopilotCliSessionCatalog } from "./copilot-cli-session-catalog.js";
import { createReadStateStore } from "./read-state-store.js";
import { createModelAbTestStore } from "./model-ab-test.js";
import { createChatGradeStore, createChatGrader, createChatGradesService, hasChatEventsLog, readChatEventsForGrading } from "./chat-grading.js";
import { createChecklistStore } from "./checklist-store.js";
import { createCalendarStore } from "./calendar-store.js";
import { createDocsStore } from "./docs-store.js";
import { createDocsIndex } from "./docs-index.js";
import { createSearchIndex } from "./search-index.js";
import { createDocsSnapshotStore, STARTUP_SNAPSHOT_MIN_INTERVAL_MS } from "./docs-snapshot-store.js";
import { createTagStore } from "./tag-store.js";
import { createMcpServerStore } from "./mcp-server-store.js";
import { createCopilotModelPriceStore } from "./copilot-model-price-store.js";
import { createCopilotUsageStore } from "./copilot-usage-store.js";
import { createTelemetryStore } from "./telemetry-store.js";
import { createSessionContextStore } from "./session-context-store.js";
import { createVoiceJobStore } from "./voice-job-store.js";
import { createPushNotificationService, initPushEventNotifications } from "./push-notification-service.js";
import { createPushSubscriptionStore } from "./push-subscription-store.js";
import { createEventBusRegistry } from "./event-bus.js";
import { createGlobalBus } from "./global-bus.js";
import type { AppContext } from "./app-context.js";
import { createTranscriptionService } from "./transcription-service.js";
import { createVoiceJobManager } from "./voice-job-manager.js";
import { createVoiceRuntime, followSelectedSpeechModel } from "./voice/voice-runtime.js";
import { createHelmStore } from "./helm/helm-store.js";
import { createHelmThinkerStore } from "./helm/thinker/store.js";
import type { RuntimePaths } from "./runtime-paths.js";
import { createDeferredPromptStore } from "./deferred-prompt-store.js";
import { createDeferredPromptRunner } from "./deferred-prompt-runner.js";
import { createTriggerStore } from "./triggers/store.js";
import { createTriggerService } from "./triggers/service.js";
import { createTriggerChatRunner } from "./triggers/chat-runner.js";
import { createTriggerTaskRunner } from "./triggers/task-runner.js";
import { createInterruptedRunStore } from "./interrupted-run-store.js";
import { createChatMessageIdStore } from "./chat-message-id-store.js";
import { createUnsentMessageStore } from "./unsent-message-store.js";
import { createBackgroundCommandStore } from "./background-command-store.js";
import { createDeferDeliveryGuard } from "./defer-delivery-guard.js";
import { createSessionManager } from "./session-manager.js";

import { createManagementJobStore } from "./management-job-store.js";
import { createEventLogStatsFoldStore } from "./event-log-stats-fold-store.js";
import { resolveSessionEventsPath, setEventLogStatsPersistence } from "./session-disk-reader.js";
import { isUnlistedSessionId } from "./unlisted-sessions.js";
import {
  BridgeToolsMcpServer,
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
  const globalBus = createGlobalBus();
  const eventBusRegistry = createEventBusRegistry();
  const taskStore = createTaskStore(db, globalBus, { runtimePaths });
  const taskGroupStore = createTaskGroupStore(db, globalBus);
  const settingsStore = createSettingsStore(db);
  const sessionMetaStore = createSessionMetaStore(db);
  const sessionWorkspaceStore = createSessionWorkspaceStore(db);
  const sessionPlaybookStore = createSessionPlaybookStore(db);
  const skillUsageStore = createSkillUsageStore(db);
  const taskStartersStore = createTaskStartersStore(db);
  const unattendedRunStore = createUnattendedRunStore(db);
  let skillCatalog: ReturnType<typeof createSkillCatalog> | undefined;
  const skillPacks = createSkillPackManager({
    dataDir,
    getPacks: () => settingsStore.getSettings().skillPacks ?? [],
    onChanged: () => { void skillCatalog?.refresh().catch(() => undefined); },
  });
  skillCatalog = createSkillCatalog({
    getCopilotHome: () => runtimePaths.copilotHome ?? join(homedir(), ".copilot"),
    listPackRoots: () => skillPacks.activeRoots(undefined, { ignoreTags: true }),
    onRefreshed: () => globalBus.emit({ type: "skills:changed" }),
  });
  const taskHistoryStore = createTaskHistoryStore(db);
  const completionReportStore = createCompletionReportStore(db);
  const taskPageStore = createTaskPageStore(db);
  const sessionTitles = createSessionTitlesStore(db);
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);
  const readStateStore = createReadStateStore(db);
  const modelAbTestStore = createModelAbTestStore(db);
  const chatGradeStore = createChatGradeStore(db);
  const checklistStore = createChecklistStore(db, globalBus);
  const calendarStore = createCalendarStore(db, globalBus);
  const telemetryStore = createTelemetryStore(db);
  const tagStore = createTagStore(db);
  const mcpServerStore = createMcpServerStore(db);
  const copilotModelPriceStore = createCopilotModelPriceStore(db);
  const copilotUsageStore = createCopilotUsageStore(db);
  const sessionContextStore = createSessionContextStore(db);
  // Durable fold cache: large session logs resume their stats scan after a restart.
  setEventLogStatsPersistence(createEventLogStatsFoldStore(db));
  const cliSessionCatalog = createCopilotCliSessionCatalog({
    copilotHome: runtimePaths.copilotHome,
    recordSpan: (name, duration, sessionId, metadata) =>
      telemetryStore.recordSpan({ name, duration, sessionId, metadata, source: "server" }),
  });
  const voiceJobStore = createVoiceJobStore(db);
  const pushSubscriptionStore = createPushSubscriptionStore(db);
  const managementJobStore = createManagementJobStore(db, { dataDir });
  const docsStore = createDocsStore(runtimePaths.docsDir);
  const docsIndex = createDocsIndex(db, docsStore, {
    // Agents write docs through tools while a reader has the page open; tell clients to refresh.
    onChange: (change) => globalBus.emit({ type: "docs:changed", ...(change.path ? { docPath: change.path } : {}) }),
  });
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
  const triggerStore = createTriggerStore(db);
  const interruptedRunStore = createInterruptedRunStore(db);
  const chatMessageIdStore = createChatMessageIdStore(db);
  const unsentMessageStore = createUnsentMessageStore(db);
  try {
    const interrupted = unsentMessageStore.recoverAfterRestart();
    if (interrupted > 0) console.log(`[chat] ${interrupted} message(s) never reached the agent before the last stop; kept as not sent`);
  } catch (error) {
    console.warn("[chat] Could not mark undelivered messages after restart:", error instanceof Error ? error.message : error);
  }
  const backgroundCommandStore = createBackgroundCommandStore(db);
  const deferDeliveryGuard = createDeferDeliveryGuard();
  const copilotHome = runtimePaths.copilotHome;
  const voiceRuntime = createVoiceRuntime(runtimePaths);
  // A preview pointed at the production voice folder must leave what is in it alone.
  followSelectedSpeechModel(voiceRuntime, () => settingsStore.getSettings().chatMic, {
    fetchMissing: !(options.isStaging && runtimePaths.env.BRIDGE_VOICE_DIR?.trim()),
  });
  const helmStore = createHelmStore(db);
  const helmThinkerStore = createHelmThinkerStore(db);

  const ctx: AppContext = {
    taskStore,
    taskGroupStore,
    settingsStore,
    sessionMetaStore,
    sessionWorkspaceStore,
    sessionPlaybookStore,
    skillCatalog,
    skillPacks,
    skillUsageStore,
    cuaDriver: new CuaDriverInstaller({ dataDir }),
    taskStartersStore,
    unattendedRunStore,
    taskHistoryStore,
    completionReportStore,
    taskPageStore,
    sessionTitles,
    bridgeSessionStateStore,
    cliSessionCatalog,
    readStateStore,
    modelAbTestStore,
    chatGradeStore,
    checklistStore,
    calendarStore,
    docsStore,
    docsIndex,
    docsSnapshotStore,
    tagStore,
    mcpServerStore,
    copilotModelPriceStore,
    copilotUsageStore,
    telemetryStore,
    sessionContextStore,
    globalBus,
    eventBusRegistry,
    // Late-bound: the session manager and voice job manager need ctx, so they are set below.
    sessionManager: null!,
    transcriptionService: createTranscriptionService({
      installer: voiceRuntime.installer,
      engine: voiceRuntime.engine,
      env: runtimePaths.env,
      logger: console,
    }),
    voiceRuntime,
    helmStore,
    helmThinkerStore,
    voiceJobManager: null!,
    pushSubscriptionStore,
    managementJobStore,
    deferredPromptStore,
    triggerStore,
    interruptedRunStore,
    chatMessageIdStore,
    unsentMessageStore,
    backgroundCommandStore,
    copilotHome,
    apiBasePath: options.apiBasePath,
    runtimePaths,
    launcherLogPath: options.launcherLogPath,
    isStaging: options.isStaging,
  };

  const excludedToolNames = new Set(options.excludedToolNames ?? []);
  const bridgeToolsMcpServer = new BridgeToolsMcpServer(ctx);
  registerAllBridgeTools(bridgeToolsMcpServer, ctx, { excludedToolNames });
  ctx.bridgeToolsMcpServer = bridgeToolsMcpServer;

  const sessionManager = createSessionManager(ctx, {
    config: {
      get sessionMcpServers() {
        return settingsStore.getMcpServers();
      },
      ...(options.sessionModel ? { model: options.sessionModel } : {}),
    },
    ...(copilotHome ? { copilotHome } : {}),
    runtimePaths,
  });
  ctx.sessionManager = sessionManager;
  ctx.chatGrades = createChatGradesService({
    store: chatGradeStore,
    grader: createChatGrader({
      store: chatGradeStore,
      classify: (request) => sessionManager.classifyTrajectory(request),
      readEvents: (sessionId) => readChatEventsForGrading(resolveSessionEventsPath(copilotHome, sessionId)),
    }),
    // The usage reader is created with the API services; until then there are no chats to offer.
    readUsageSessions: async () => (await ctx.copilotUsageReader?.readSummary({ range: "all" }))?.sessions ?? [],
    scheduledSessionIds: (sessionIds) => new Set(Object.values(bridgeSessionStateStore.listStatesFor(sessionIds))
      .filter((state) => state.triggeredBy === "schedule")
      .map((state) => state.sessionId)),
    hasEventsLog: (sessionId) => hasChatEventsLog(resolveSessionEventsPath(copilotHome, sessionId)),
    chatTitles: async (sessionIds) => {
      const states = bridgeSessionStateStore.listStatesFor(sessionIds);
      const catalog = sessionIds.length > 0 ? await cliSessionCatalog.listSessions({ ids: sessionIds }).catch(() => undefined) : undefined;
      const summaries = new Map((catalog ?? []).map((session) => [session.sessionId, session.summary?.trim()]));
      return new Map(sessionIds.map((sessionId) => [
        sessionId,
        states[sessionId]?.titleOverride?.trim() || sessionTitles.getTitle(sessionId)?.trim() || summaries.get(sessionId) || "",
      ]));
    },
    modelNames: async () => new Map((await sessionManager.listModels()).map((model) => [model.id, model.name])),
  });
  ctx.searchIndex = createSearchIndex(db, {
    copilotHome: copilotHome ?? join(homedir(), ".copilot"),
    taskStore,
    sessionMetaStore,
    sessionTitles,
    docsIndex,
    recordSpan: (name, duration, metadata) => telemetryStore.recordSpan({ name, duration, metadata, source: "server" }),
    listSessions: async () => {
      const sessionStateDir = join(copilotHome ?? join(homedir(), ".copilot"), "session-state");
      try {
        return (await readdir(sessionStateDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !isUnlistedSessionId(entry.name))
          .map((entry) => ({ sessionId: entry.name }));
      } catch (error) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && (error as { code?: unknown }).code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }
    },
    readSessionTitle: async (sessionId) => {
      try {
        const content = await readFile(
          join(copilotHome ?? join(homedir(), ".copilot"), "session-state", sessionId, "workspace.yaml"),
          "utf8",
        );
        return parseWorkspaceYamlSessionName(content);
      } catch (error) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
        ) {
          return undefined;
        }
        throw error;
      }
    },
  });
  ctx.voiceJobManager = createVoiceJobManager({
    dataDir,
    store: voiceJobStore,
    transcriptionService: ctx.transcriptionService,
    sessionManager,
    taskStore,
    chatDelivery: ctx,
    settingsStore,
  });
  ctx.pushNotificationService = createPushNotificationService({
    subscriptionStore: pushSubscriptionStore,
    env: runtimePaths.env,
  });
  ctx.stopPushEventNotifications = initPushEventNotifications(ctx, ctx.pushNotificationService, {
    getSessions: () => sessionManager.getPendingInputSessionIds().filter(sessionId => !isUnlistedSessionId(sessionId)).map(sessionId => ({
      sessionId, pendingUserInputCount: sessionManager.getPendingUserInputCount(sessionId),
    })),
    startImmediately: false,
  });
  const emitTriggerSummary = (sessionId: string) => ctx.triggerService?.emitChatSummary(sessionId);
  ctx.deferredPromptRunner = createDeferredPromptRunner(
    deferredPromptStore,
    sessionManager,
    globalBus,
    deferDeliveryGuard,
    {
      telemetryStore,
      // A trigger may be waiting for the chat a message just let go of.
      onSettled: () => ctx.triggerChatRunner?.poke(),
    },
  );
  ctx.triggerChatRunner = createTriggerChatRunner(triggerStore, sessionManager, globalBus, deferDeliveryGuard, {
    telemetryStore,
    emitSummary: emitTriggerSummary,
    onParentMessageQueued: () => ctx.deferredPromptRunner?.poke(),
  });
  ctx.triggerTaskRunner = createTriggerTaskRunner({
    store: triggerStore,
    taskStore,
    taskHistoryStore,
    sessionManager,
    sessionMetaStore,
    globalBus,
    telemetryStore,
  });
  ctx.triggerService = createTriggerService({
    store: triggerStore,
    taskStore,
    globalBus,
    deferredPromptStore,
    chatRunner: ctx.triggerChatRunner,
    taskRunner: ctx.triggerTaskRunner,
    outboxRunner: ctx.deferredPromptRunner,
  });
  return { ctx, db };
}

export function initializeTriggerAndDeliveryRunners(ctx: AppContext): void {
  void ctx.stopPushEventNotifications?.flush();
  startSkillCatalog(ctx);
  try {
    ctx.managementJobStore?.reconcileResultDeliveries();
  } catch (error) {
    console.error("[management-jobs] Could not queue unsent job results at startup:", error);
  }
  ctx.deferredPromptRunner?.start();
  ctx.triggerChatRunner?.start();
  ctx.triggerTaskRunner?.start();
}
/** Git packs older than this are fetched again when the server starts. */
const SKILL_PACK_STARTUP_STALE_MS = 12 * 60 * 60_000;

/** Sessions started before the first scan only miss their <skill_roles> hints. */
export function startSkillCatalog(ctx: AppContext): void {
  const catalog = ctx.skillCatalog;
  const packs = ctx.skillPacks;
  if (!catalog) return;
  void (async () => {
    try {
      await packs?.listStatuses();
    } catch (error) {
      console.warn("[skill-packs] Could not read pack state:", error instanceof Error ? error.message : error);
    }
    catalog.start();
    if (packs && !ctx.isStaging) {
      try {
        await packs.syncAll({ staleAfterMs: SKILL_PACK_STARTUP_STALE_MS });
        await packs.pruneRemoved();
      } catch (error) {
        console.warn("[skill-packs] Startup sync failed:", error instanceof Error ? error.message : error);
      }
    }
  })();
}
