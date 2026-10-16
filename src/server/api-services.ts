import { join } from "node:path";
import { homedir } from "node:os";
import type { AppContext } from "./app-context.js";
import { maxIsoTime } from "../shared/session-activity.js";
import { createSessionList, type SessionList } from "./session-list.js";
import { buildSessionWorkspaceSummaryForList, getSessionStatus } from "./session-view.js";
import { resolveSessionCreationOptions } from "./session-creation-options.js";
import { SessionBackendDeleteError } from "./session-manager.js";
import { setSessionsArchived } from "./session-archive.js";
import { sendChatMessage } from "./chat-message-delivery.js";
import { createTranscriptionService, type TranscriptionService } from "./transcription-service.js";
import type { VoiceJobManager } from "./voice-job-manager.js";
import { createBridgeGitRevisionReader } from "./git-revisions.js";
import { createSessionStorageReader, type SessionStorageReader } from "./session-storage-reader.js";
import { createIncrementalCopilotUsageReader } from "./copilot-usage-index.js";
import type { CopilotUsageReader } from "./copilot-usage.js";
import { createCopilotModelPriceLoader } from "./copilot-model-price-loader.js";
import { createCopilotQuotaReader, type CopilotQuotaReader } from "./copilot-quota.js";
import { HelmService, HELM_DEFAULT_REASONING_EFFORTS } from "./helm/helm-service.js";
import type { HelmBridgeFacade, HelmSessionSummary } from "./helm/helm-tools.js";
import { VoiceGateway, type VoiceGatewayHelm } from "./voice/voice-gateway.js";
import { createVoiceRuntime, type VoiceRuntime } from "./voice/voice-runtime.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { setSettingsGetter } from "./providers/index.js";
import { createServerShutdownCoordinator, type ServerShutdownCoordinator } from "./shutdown-coordinator.js";

const HELM_UNAVAILABLE: VoiceGatewayHelm = {
  isHelmSession: () => false,
  bindHandsFree: () => () => undefined,
  isWatched: () => false,
  getTurnCount: () => 0,
  getTurnReasoningEffort: (mode) => HELM_DEFAULT_REASONING_EFFORTS[mode],
};

export interface ApiServiceOptions {
  shutdownCoordinator?: ServerShutdownCoordinator;
  sessionStorageReader?: SessionStorageReader;
  copilotQuotaReader?: CopilotQuotaReader;
}

export interface ApiServices {
  shutdownCoordinator: ServerShutdownCoordinator;
  voiceRuntime: VoiceRuntime;
  voiceGateway: VoiceGateway;
  transcriptionService: TranscriptionService;
  voiceJobManager: VoiceJobManager;
  getBridgeGitRevisions: ReturnType<typeof createBridgeGitRevisionReader>;
  sessionStorageReader: SessionStorageReader;
  copilotUsageReader: CopilotUsageReader;
  copilotQuotaReader: CopilotQuotaReader;
  sessionList: SessionList;
  deleteSessionWithOwnedState(sessionId: string, reason: string, opts?: { deferInvalidation?: boolean }): Promise<void>;
  resolveReadThroughActivityAt(sessionId: string, requested?: string): string;
  emitReadStateChanged(): void;
}

/** Startup composition shared by production, staged backends and test applications. */
export function createApiServices(ctx: AppContext, options: ApiServiceOptions = {}): ApiServices {
  const shutdownCoordinator = options.shutdownCoordinator ?? createServerShutdownCoordinator(ctx);
  const copilotHome = ctx.copilotHome ?? join(homedir(), ".copilot");
  const voiceRuntime = ctx.voiceRuntime ??= createVoiceRuntime(ctx.runtimePaths ?? resolveRuntimePaths(process.env));
  const transcriptionService = ctx.transcriptionService
    ?? createTranscriptionService({ installer: voiceRuntime.installer, engine: voiceRuntime.engine, env: ctx.runtimePaths?.env });
  const voiceJobManager = ctx.voiceJobManager;
  const getBridgeGitRevisions = createBridgeGitRevisionReader();
  const sessionStorageReader = options.sessionStorageReader
    ?? createSessionStorageReader(join(copilotHome, "session-state"));
  let copilotUsageReader = ctx.copilotUsageReader;
  if (!copilotUsageReader) {
    const modelPriceLoader = createCopilotModelPriceLoader({
      loadModels: () => ctx.sessionManager.listModels(), store: ctx.copilotModelPriceStore,
    });
    copilotUsageReader = createIncrementalCopilotUsageReader({
      copilotHome, store: ctx.copilotUsageStore, modelPriceLoader,
    });
    ctx.copilotUsageReader = copilotUsageReader;
  }
  copilotUsageReader.startBackgroundRefresh?.();
  const copilotQuotaReader = options.copilotQuotaReader ?? createCopilotQuotaReader({
    getQuota: () => ctx.sessionManager.getAccountQuota(),
    getAuth: () => ctx.sessionManager.getAccountAuth(),
    getLiveUser: () => ctx.sessionManager.fetchAccountCopilotUser(),
  });
  const sessionList = createSessionList(ctx, {
    getStatus: (sessionId) => getSessionStatus(ctx, sessionId),
    summarizeWorkspace: (sessionId, inputs) => buildSessionWorkspaceSummaryForList(ctx, sessionId, inputs),
  });

  function emitReadStateChanged(): void {
    ctx.globalBus.emit({ type: "readstate:changed", readState: ctx.readStateStore.getReadState() });
  }

  function resolveReadThroughActivityAt(sessionId: string, requested?: string): string {
    const meta = ctx.sessionMetaStore.getMeta(sessionId);
    const latestActivityAt = maxIsoTime(meta?.lastVisibleActivityAt, meta?.lastAttentionAt);
    const latestActivityTime = latestActivityAt ? Date.parse(latestActivityAt) : Number.NaN;
    const latestActivity = Number.isFinite(latestActivityTime) ? new Date(latestActivityTime).toISOString() : undefined;
    if (!requested) return latestActivity ?? new Date().toISOString();
    const requestedTime = Date.parse(requested);
    if (latestActivity && Number.isFinite(latestActivityTime) && requestedTime > latestActivityTime) return latestActivity;
    return new Date(Math.min(requestedTime, Date.now() + 5_000)).toISOString();
  }

  async function deleteSessionWithOwnedState(
    sessionId: string,
    reason: string,
    opts: { deferInvalidation?: boolean } = {},
  ): Promise<void> {
    let backendDeleteError: SessionBackendDeleteError | undefined;
    try {
      await ctx.sessionManager.deleteSession(sessionId);
    } catch (error) {
      if (!(error instanceof SessionBackendDeleteError)) throw error;
      backendDeleteError = error;
    }
    if (!opts.deferInvalidation) sessionList.invalidate(reason);
    ctx.sessionMetaStore.deleteMeta(sessionId);
    ctx.readStateStore.markUnread(sessionId);
    ctx.sessionContextStore?.deleteSessionContext(sessionId);
    ctx.deferredPromptStore?.cancelForSession(sessionId);
    ctx.deferLoopStore?.cancelForSession(sessionId);
    ctx.deferredPromptStore?.deleteForSession(sessionId);
    ctx.deferLoopStore?.deleteForSession(sessionId);
    ctx.taskStore.unlinkSessionFromAllTasks(sessionId);
    if (backendDeleteError) throw backendDeleteError;
  }

  const facade: HelmBridgeFacade = {
    listSessions: async (options) => {
      const sessions = await sessionList.read(options?.includeArchived === true);
      const readState = ctx.readStateStore.getReadStateFor(sessions.map((session) => session.sessionId));
      return sessions.map((session): HelmSessionSummary => {
        const activity: string | undefined = session.lastActivityAt ?? session.modifiedTime ?? session.startTime;
        const lastRead = readState[session.sessionId];
        return {
          sessionId: session.sessionId,
          title: typeof session.summary === "string" && session.summary.trim() ? session.summary.trim() : "Untitled session",
          runState: session.runState ?? "idle",
          needsUserInput: !!session.needsUserInput,
          unread: !!activity && (!lastRead || Date.parse(activity) > Date.parse(lastRead)),
          archived: !!session.archived,
          lastActivityAt: activity,
          linkedTaskIds: Array.isArray(session.linkedTaskIds) ? session.linkedTaskIds : [],
          intentText: session.intentText ?? null,
          ...(typeof session.triggeredBy === "string" ? { triggeredBy: session.triggeredBy } : {}),
          ...(typeof session.scheduleName === "string" && session.scheduleName ? { scheduleName: session.scheduleName } : {}),
        };
      });
    },
    markRead: (sessionIds) => {
      for (const sessionId of sessionIds) ctx.readStateStore.markRead(sessionId, resolveReadThroughActivityAt(sessionId));
      emitReadStateChanged();
    },
    setArchived: (sessionIds, archived) => {
      const { errors } = setSessionsArchived(ctx, sessionIds, archived);
      const failure = Object.values(errors)[0];
      if (failure !== undefined) throw new Error(failure);
    },
    sendMessage: async (sessionId, prompt) => {
      console.log(`[helm] [${sessionId.slice(0, 8)}] "${prompt.slice(0, 80)}"`);
      const { delivery } = await sendChatMessage(ctx, sessionId, prompt, { queue: "none" });
      return delivery === "started" ? "started" : "steered";
    },
    createSession: async ({ taskId, model, reasoningEffort }) => {
      const creation = await resolveSessionCreationOptions(ctx, { model, reasoningEffort }, taskId ? { taskId } : {});
      if (creation.error) throw new Error(creation.error);
      if (!taskId) {
        const result = await ctx.sessionManager.createSession({ background: true, ...creation.options });
        sessionList.invalidate("helm:session:create");
        return result;
      }
      const task = ctx.taskStore.getTask(taskId);
      if (!task) throw new Error("Task not found");
      const result = await ctx.sessionManager.createTaskSession(
        task.id, task.title, task.workItems, task.notes, task.cwd, undefined,
        { background: true, ...creation.options },
      );
      sessionList.invalidate("helm:task-session:create");
      ctx.taskStore.linkSession(task.id, result.sessionId);
      return result;
    },
  };
  if (ctx.helmStore && !ctx.helm) {
    ctx.helm = new HelmService({
      ctx, store: ctx.helmStore, facade,
      deleteSession: async (sessionId) => {
        await deleteSessionWithOwnedState(sessionId, "helm:conversation:delete");
        emitReadStateChanged();
      },
    });
    ctx.helm.startRetention();
  }
  ctx.voiceGateway ??= new VoiceGateway({ ctx, facade, helm: ctx.helm ?? HELM_UNAVAILABLE, runtime: voiceRuntime });
  setSettingsGetter(() => ctx.settingsStore.getSettings());

  ctx.globalBus.subscribe((event) => {
    switch (event.type) {
      case "session:title":
      case "task:changed":
        sessionList.invalidate(`bus:${event.type}`);
        break;
      case "sessions:changed":
        if (event.reason !== "attention") sessionList.invalidate("bus:sessions:changed");
        break;
      case "session:archived":
        sessionList.invalidate("bus:session:archived", [event.archived === true ? "all" : "active"]);
        break;
    }
  });

  return {
    shutdownCoordinator,
    voiceRuntime, voiceGateway: ctx.voiceGateway, transcriptionService, voiceJobManager, getBridgeGitRevisions,
    sessionStorageReader, copilotUsageReader, copilotQuotaReader, sessionList,
    deleteSessionWithOwnedState, resolveReadThroughActivityAt, emitReadStateChanged,
  };
}
