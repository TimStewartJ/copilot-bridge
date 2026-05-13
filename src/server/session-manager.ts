// Copilot SDK session manager
// Universal tools — taskId is a parameter, same tools for every session

import { CopilotClient, defineTool, type CopilotClientOptions } from "@github/copilot-sdk";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLastVisibleActivityAt, transformEventsToMessages, type TransformedEntry } from "./event-transform.js";
import { config } from "./config.js";
import { createTaskStore } from "./task-store.js";
import type { WorkItemRef } from "./task-store.js";
import type { Task } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createScheduleStore } from "./schedule-store.js";
import { getOrCreateBus } from "./event-bus.js";
import {
  buildSessionConfig as buildSessionConfigWithDeps,
  type ScheduleContext,
  type SessionConfigOptions,
} from "./session-config-builder.js";
export {
  BRIDGE_EXCLUDED_TOOLS,
  BROWSER_GUIDANCE,
  DEFAULT_IDENTITY,
  DEMO_MODE_INSTRUCTIONS,
  FEED_GUIDANCE,
  RESEARCH_GUIDANCE,
  STAGING_INSTRUCTIONS,
} from "./session-instructions.js";
export type { ScheduleContext, SessionConfigOptions } from "./session-config-builder.js";
export {
  formatTaskMomentumContext,
} from "./session-task-momentum.js";
export {
  buildSessionAttachmentUrlPath,
  encodeAttachmentUrlSegment,
  escapeAttachmentMarkdownText,
  escapePromptLiteral,
  escapePromptText,
  escapeUnicodeLineSeparators,
  formatPromptTag,
  formatPromptTagList,
  formatRelatedDocManifestEntry,
  normalizeInlineText,
  parseWorkspaceCwd,
  renderPublishedAttachment,
  resolvePublishableAttachmentSourcePath,
} from "./session-formatting.js";
import type { AppContext } from "./app-context.js";
import type { GlobalBus } from "./global-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { TaskStore } from "./task-store.js";
import type { ChecklistStore } from "./checklist-store.js";
import type { SessionWorkspaceStore } from "./session-workspace-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { CopilotCliSessionCatalog } from "./copilot-cli-session-catalog.js";

import type { SettingsStore } from "./settings-store.js";
import type { TagStore } from "./tag-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore } from "./docs-store.js";
import type { BrowserSessionStore } from "./browser-session-store.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { McpServerStore } from "./mcp-server-store.js";
import { getOrCreateBrowserSessionStore } from "./browser-session-store.js";
import { getBridgeBrowserTarget, shutdownBridgeBrowser } from "./agent-browser.js";
import type { RuntimePaths } from "./runtime-paths.js";
import { UserInputBrokerError, type UserInputBroker } from "./user-input-broker.js";
import type { NativeUserInputRequest, NativeUserInputResponse, UserInputCancelReason, UserInputRequestId } from "./user-input-types.js";
import { SessionWorkspaceController } from "./session-workspace-controller.js";
import { SessionUserInputController } from "./session-user-input-controller.js";
import {
  deduplicateFilename as deduplicateAttachmentFilename,
  persistAndRouteAttachments as persistAndRouteSessionAttachments,
  type RoutedSdkAttachment,
  type StartWorkAttachment,
} from "./session-attachment-routing.js";
import {
  listSessionsFromDisk as listSessionsFromDiskWithDeps,
  readMessagesFromDisk as readMessagesFromDiskWithDeps,
} from "./session-disk-reader.js";
import {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
  RESTART_PENDING_MESSAGE,
  configureRestartEventBus,
  configureRestartActiveSessionCountProvider,
  configureRestartStateStore,
  isRestartCutoverInProgress,
  isRestartPending,
  refreshRestartState,
  refreshRestartStateSync,
  syncRestartWaitingSessions,
  triggerRestartPending,
} from "./restart-controller.js";
import {
  ABORT_CONFIRMATION_TIMEOUT_MS,
  SessionRunStateController,
  type SessionRunController,
  type SessionRunRecord,
  type SessionRunState,
  type SessionActivity,
} from "./session-run-state-controller.js";
import { SessionRunner, type McpServerStatus, type StartWorkOptions } from "./session-runner.js";
export type { McpServerStatus, StartWorkOptions } from "./session-runner.js";
import {
  deriveModelStateFromEventsFile,
  type DerivedModelState,
} from "./session-events-model.js";
import {
  buildSessionNameResumeConfig,
  createSessionNameRpc,
  type SetSessionNameOptions,
  type SessionNameRpc,
} from "./session-name-rpc.js";
import {
  createSessionNameAutogenerator,
  type SessionNameAutogenerator,
} from "./session-name-autogen.js";
import { deleteCliSessionStoreRows, sweepLeakedCliSessionStoreRows } from "./cli-session-store.js";
import { DISPOSABLE_TITLE_SESSION_ID_PREFIX } from "./session-name-generator.js";
import { migrateLegacySessionTitles as migrateLegacySessionTitlesWithDeps } from "./migrate-legacy-session-titles.js";
export type { DerivedModelState } from "./session-events-model.js";
export {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
  RESTART_PENDING_MESSAGE,
  clearRestartPending,
  configureRestartEventBus,
  configureRestartStateStore,
  getRestartWaitingCount,
  isPromptDeliveryInterruptedError,
  isRestartCutoverInProgress,
  isRestartImminent,
  isRestartPending,
  isRestartPendingError,
  refreshRestartState,
  refreshRestartStateSync,
  syncRestartWaitingSessions,
  triggerRestartPending,
} from "./restart-controller.js";
export type {
  PromptDeliveryResult,
  SessionActivity,
  SessionRunController,
  SessionRunRecord,
  SessionRunState,
} from "./session-run-state-controller.js";

// Universal tools — same instance for every session
export { createBridgeTools } from "./bridge-tools.js";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildCopilotClientOptions(
  clientEnv?: Record<string, string | undefined>,
): CopilotClientOptions | undefined {
  const gitHubToken = normalizeOptionalEnvValue(
    clientEnv?.[BRIDGE_COPILOT_GITHUB_TOKEN_ENV] ?? process.env[BRIDGE_COPILOT_GITHUB_TOKEN_ENV],
  );
  if (!clientEnv && !gitHubToken) return undefined;

  return {
    ...(clientEnv ? { env: clientEnv } : {}),
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|no such (file|session)|ENOENT/i.test(message);
}

export interface SessionManagerDeps {
  tools: ReturnType<typeof defineTool>[];
  globalBus: GlobalBus;
  eventBusRegistry: EventBusRegistry;
  userInputBroker?: UserInputBroker;
  sessionTitles: SessionTitlesStore;
  sessionWorkspaceStore?: SessionWorkspaceStore;
  sessionMetaStore?: SessionMetaStore;
  cliSessionCatalog?: Pick<CopilotCliSessionCatalog, "hasSession">;
  taskStore: TaskStore;
  taskGroupStore?: TaskGroupStore;
  checklistStore?: ChecklistStore;
  settingsStore?: SettingsStore;
  tagStore?: TagStore;
  mcpServerStore?: McpServerStore;
  docsIndex?: DocsIndex;
  docsStore?: DocsStore;
  browserSessionStore?: BrowserSessionStore;
  config: { sessionMcpServers: Record<string, McpServerConfig>; model?: string };
  telemetryStore?: TelemetryStore;
  /** Custom env for CopilotClient — use to set COPILOT_HOME for session isolation */
  clientEnv?: Record<string, string | undefined>;
  /** Root of .copilot directory — defaults to homedir()/.copilot */
  copilotHome?: string;
  runtimePaths?: RuntimePaths;
}

/** Options that don't come from AppContext — caller provides these directly. */
export interface CreateSessionManagerOpts {
  tools: ReturnType<typeof defineTool>[];
  config: SessionManagerDeps["config"];
  clientEnv?: SessionManagerDeps["clientEnv"];
  copilotHome?: string;
  runtimePaths?: RuntimePaths;
}
export interface McpLoginResult {
  serverName: string;
  authorizationUrl?: string;
  servers: McpServerStatus[];
}


/**
 * Factory that maps AppContext → SessionManagerDeps.
 *
 * Staging preview dynamically imports this from the worktree, so new deps are
 * picked up automatically without touching staging-tools.ts.
 */
export function createSessionManager(ctx: AppContext, opts: CreateSessionManagerOpts): SessionManager {
  const runtimePaths = opts.runtimePaths ?? ctx.runtimePaths;
  const copilotHome = opts.copilotHome ?? ctx.copilotHome ?? runtimePaths?.copilotHome;
  const clientEnv = opts.clientEnv
    ?? runtimePaths?.env
    ?? (copilotHome ? { ...process.env, COPILOT_HOME: copilotHome } : undefined);
  return new SessionManager({
    tools: opts.tools,
    globalBus: ctx.globalBus,
    eventBusRegistry: ctx.eventBusRegistry,
    sessionTitles: ctx.sessionTitles,
    sessionWorkspaceStore: ctx.sessionWorkspaceStore,
    sessionMetaStore: ctx.sessionMetaStore,
    cliSessionCatalog: ctx.cliSessionCatalog,
    taskStore: ctx.taskStore,
    taskGroupStore: ctx.taskGroupStore,
    checklistStore: ctx.checklistStore,
    settingsStore: ctx.settingsStore,
    tagStore: ctx.tagStore,
    mcpServerStore: ctx.mcpServerStore ?? ctx.settingsStore.getMcpServerStore(),
    docsIndex: ctx.docsIndex,
    docsStore: ctx.docsStore,
    browserSessionStore: getOrCreateBrowserSessionStore(ctx, {
      copilotHome,
      telemetryStore: ctx.telemetryStore,
    }),
    telemetryStore: ctx.telemetryStore,
    config: opts.config,
    clientEnv,
    copilotHome,
    runtimePaths,
  });
}

export class SessionManager {
  private static DISPOSABLE_TITLE_SWEEP_GRACE_MS = 60_000;
  private client: CopilotClient | null = null;
  private deps: SessionManagerDeps;
  private readonly processStartedAtMs = Date.now();
  private activeRunControllers = new Map<string, SessionRunController>();
  private resumingSessions = new Map<string, number>();
  private modelSwitchingSessions = new Set<string>();
  private sessionObjects = new Map<string, any>(); // cached CopilotSession objects
  private mcpStatus = new Map<string, McpServerStatus[]>(); // per-session MCP server status
  private liveSessionModelState = new Map<string, DerivedModelState>();
  private pendingSessionEvictions = new Set<string>();
  private readonly workspaceController: SessionWorkspaceController;
  private readonly userInputController: SessionUserInputController;
  private readonly runStateController: SessionRunStateController;
  private readonly sessionNameRpc: SessionNameRpc;
  private readonly sessionNameAutogenerator: SessionNameAutogenerator;
  private readonly sessionRunner: SessionRunner;
  readonly sessionRuns: Map<string, SessionRunRecord>;

  // listSessions cache — avoids expensive SDK filesystem scan on every call
  private sessionListCache: { data: any[]; timestamp: number } | null = null;
  private sessionDiskListCache = new Map<string, { data: any[]; timestamp: number; generation: number }>();
  private sessionDiskListBuilds = new Map<string, { generation: number; promise: Promise<any[]> }>();
  private sessionDiskListCacheGeneration = 0;
  private warmSessionPromises = new Map<string, Promise<void>>();
  private static SESSION_LIST_TTL = 60_000; // 1 minute TTL
  private static SESSION_DISK_LIST_TTL = 30_000; // 30 seconds

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
    this.workspaceController = new SessionWorkspaceController({
      sessionWorkspaceStore: deps.sessionWorkspaceStore,
      taskStore: deps.taskStore,
      copilotHome: deps.copilotHome,
      runtimePaths: deps.runtimePaths,
      isSessionBusy: (sessionId) => this.isSessionBusy(sessionId),
      onWorkspaceChange: (sessionId, { busy }) => {
        if (busy) {
          this.pendingSessionEvictions.add(sessionId);
        } else {
          this.evictCachedSession(sessionId);
        }
        this.invalidateSessionListCache("workspace:changed");
      },
    });
    this.userInputController = new SessionUserInputController({
      broker: deps.userInputBroker,
      eventBusRegistry: deps.eventBusRegistry,
      globalBus: deps.globalBus,
      touchActivity: (sessionId, timestamp) => this.touchUserInputActivity(sessionId, timestamp),
    });
    this.runStateController = new SessionRunStateController({
      globalBus: deps.globalBus,
      isRestartPending,
      syncRestartWaitingSessions,
      getActiveSessionCount: () => this.getActiveSessions().length,
      isSessionResuming: (sessionId) => this.isSessionResuming(sessionId),
      cancelPendingUserInputRequests: (sessionId, reason, message) =>
        this.cancelPendingUserInputRequests(sessionId, reason, message),
      promptDeliveryAbortedMessage: PROMPT_DELIVERY_ABORTED_MESSAGE,
      promptDeliveryShutdownMessage: PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
      logger: console,
    });
    this.sessionRuns = this.runStateController.getRunRecords();
    this.sessionNameRpc = createSessionNameRpc({
      withSessionNameRpc: (sessionId, operation) => this.withSessionNameRpc(sessionId, operation),
      getSessionStateDir: (sessionId) => this.getSessionStateDir(sessionId),
      emitSessionNameChanged: (sessionId, name) => this.emitSessionNameChanged(sessionId, name),
    });
    this.sessionNameAutogenerator = createSessionNameAutogenerator({
      listModels: () => this.listModels(),
      createSession: async (sessionConfig) => {
        if (!this.client) throw new Error("SessionManager not initialized");
        return this.client.createSession(sessionConfig);
      },
      deleteSession: async (sessionId) => {
        if (!this.client) return;
        await this.client.deleteSession(sessionId);
      },
      getCopilotHome: () => this.getCopilotHome(),
      getSessionName: (sessionId) => this.getSessionName(sessionId),
      setSessionName: (sessionId, name, opts) => this.setSessionName(sessionId, name, opts),
      recordSpan: (name, duration, sessionId, metadata) => this.recordSpan(name, duration, sessionId, metadata),
      logger: console,
    });
    this.sessionRunner = new SessionRunner({
      getClient: () => this.client,
      sessionObjects: this.sessionObjects,
      mcpStatus: this.mcpStatus,
      activeRunControllers: this.activeRunControllers,
      runStateController: this.runStateController,
      userInputController: this.userInputController,
      eventBusRegistry: deps.eventBusRegistry,
      globalBus: deps.globalBus,
      sessionMetaStore: deps.sessionMetaStore,
      telemetryStore: deps.telemetryStore,
      copilotHome: deps.copilotHome,
      isSessionBusy: (sessionId) => this.isSessionBusy(sessionId),
      hasPlan: (sessionId) => this.hasPlan(sessionId),
      getSessionStateDir: (sessionId) => this.getSessionStateDir(sessionId),
      buildSessionConfig: (opts) => this.buildSessionConfig(opts),
      findLinkedTask: (sessionId) => this.findLinkedTask(sessionId),
      lookupGroupNotes: (groupId) => this.lookupGroupNotes(groupId),
      persistAndRouteAttachments: (sessionId, attachments) => this.persistAndRouteAttachments(sessionId, attachments),
      cacheResumedSession: (sessionId, session) => this.cacheResumedSession(sessionId, session),
      replaceCachedSession: (sessionId, expectedSession, nextSession) =>
        this.replaceCachedSession(sessionId, expectedSession, nextSession),
      probeMcpStatus: (sessionId, session) => this.probeMcpStatus(sessionId, session),
      flushPendingSessionEviction: (sessionId) => this.flushPendingSessionEviction(sessionId),
      cancelPendingUserInputRequests: (sessionId, reason, message) =>
        this.cancelPendingUserInputRequests(sessionId, reason, message),
      recordSessionAttention: (sessionId, at) => this.markSessionAttention(sessionId, at),
      invalidateSessionListCache: () => this.invalidateSessionListCache("session-runner"),
      maybeAutoNameSession: (sessionId, options) => this.maybeAutoNameSession(sessionId, options),
    });
    configureRestartStateStore(deps.runtimePaths);
    configureRestartEventBus(deps.globalBus);
    void refreshRestartState();
  }

  private recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void {
    try {
      this.deps.telemetryStore?.recordSpan({ name, duration, sessionId, metadata, source: "server" });
    } catch { /* telemetry should never break core flow */ }
  }

  private persistLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt?: string): void {
    if (!lastVisibleActivityAt) return;
    try {
      this.deps.sessionMetaStore?.setLastVisibleActivityAt(sessionId, lastVisibleActivityAt);
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to persist visible activity:`, err);
    }
  }

  private persistLastAttentionAt(sessionId: string, lastAttentionAt?: string): void {
    if (!lastAttentionAt) return;
    try {
      this.deps.sessionMetaStore?.setLastAttentionAt(sessionId, lastAttentionAt);
      this.deps.globalBus.emit({ type: "sessions:changed", sessionId });
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to persist attention activity:`, err);
    }
  }

  markSessionAttention(sessionId: string, at = new Date().toISOString()): void {
    this.persistLastAttentionAt(sessionId, at);
  }

  private createRunController(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
  ): SessionRunController {
    return this.runStateController.createRunController(sessionId, bus);
  }

  private setSessionRunState(
    sessionId: string,
    state: SessionRunState,
    opts: { now?: number; lastEventAt?: number } = {},
  ): void {
    this.runStateController.setSessionRunState(sessionId, state, opts);
  }

  private touchSessionRun(sessionId: string, at = Date.now()): void {
    this.runStateController.touchSessionRun(sessionId, at);
  }

  private getCopilotHome(): string {
    return this.workspaceController.getCopilotHome();
  }

  private getSessionStateDir(sessionId: string): string {
    return this.workspaceController.getSessionStateDir(sessionId);
  }

  private getSessionPlanPath(sessionId: string): string {
    return join(this.getSessionStateDir(sessionId), "plan.md");
  }

  private getSessionEventsPath(sessionId: string): string {
    return join(this.getSessionStateDir(sessionId), "events.jsonl");
  }

  hasPlan(sessionId: string): boolean {
    return existsSync(this.getSessionPlanPath(sessionId));
  }

  private lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null {
    if (!groupId || !this.deps.taskGroupStore) return null;
    const group = this.deps.taskGroupStore.getGroup(groupId);
    if (!group?.notes?.trim()) return null;
    return { groupName: group.name, notes: group.notes };
  }

  private findLinkedTask(sessionId: string): Task | undefined {
    return this.workspaceController.findLinkedTask(sessionId);
  }

  private resolveEffectiveSessionCwd(opts: { sessionId?: string; task?: Pick<Task, "cwd"> | null }): string | undefined {
    return this.workspaceController.resolveEffectiveSessionCwd(opts);
  }

  private persistSessionWorkspace(sessionId: string, cwd?: string): void {
    this.workspaceController.persistSessionWorkspace(sessionId, cwd);
  }

  setSessionWorkspace(sessionId: string, cwd: string, opts: { allowDuringActiveTurn?: boolean } = {}): {
    cwd: string;
    source: "explicit";
    message: string;
  } {
    return this.workspaceController.setSessionWorkspace(sessionId, cwd, opts);
  }

  resetSessionWorkspace(
    sessionId: string,
    opts: { allowDuringActiveTurn?: boolean; taskCwd?: string; taskId?: string } = {},
  ): {
    cwd: string;
    source: "task-default";
    message: string;
  } {
    return this.workspaceController.resetSessionWorkspace(sessionId, opts);
  }

  private flushPendingSessionEviction(sessionId: string): void {
    if (!this.pendingSessionEvictions.has(sessionId) || this.isSessionBusy(sessionId)) return;
    this.pendingSessionEvictions.delete(sessionId);
    this.evictCachedSession(sessionId);
  }

  private syncRestartWaitingIfPending(): void {
    if (isRestartPending()) {
      syncRestartWaitingSessions(this.getActiveSessions().length);
    }
  }

  private beginSessionResume(sessionId: string): void {
    this.resumingSessions.set(sessionId, (this.resumingSessions.get(sessionId) ?? 0) + 1);
    this.syncRestartWaitingIfPending();
  }

  private endSessionResume(sessionId: string): void {
    const count = this.resumingSessions.get(sessionId) ?? 0;
    if (count <= 1) {
      this.resumingSessions.delete(sessionId);
    } else {
      this.resumingSessions.set(sessionId, count - 1);
    }
    this.syncRestartWaitingIfPending();
  }

  private isSessionResuming(sessionId: string): boolean {
    return (this.resumingSessions.get(sessionId) ?? 0) > 0;
  }

  private handleUserInputRequest(
    request: NativeUserInputRequest,
    invocation: { sessionId: string },
  ): Promise<NativeUserInputResponse> {
    return this.userInputController.requestUserInput(invocation.sessionId, request);
  }

  private cancelPendingUserInputRequests(
    sessionId: string,
    reason: UserInputCancelReason,
    message?: string,
  ): void {
    this.userInputController.cancelPendingSessionRequests(sessionId, reason, message);
  }

  private cancelAllPendingUserInputRequests(reason: UserInputCancelReason, message?: string): void {
    this.userInputController.cancelAllPendingRequests(reason, message);
  }

  private touchUserInputActivity(sessionId: string, timestamp?: string): void {
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
    this.touchSessionRun(sessionId, Number.isFinite(parsed) ? parsed : Date.now());
  }

  private buildSessionConfig(opts: SessionConfigOptions = {}) {
    return buildSessionConfigWithDeps({
      deps: this.deps,
      options: opts,
      callbacks: {
        resolveEffectiveSessionCwd: (cwdOpts) => this.resolveEffectiveSessionCwd(cwdOpts),
        getCopilotHome: () => this.getCopilotHome(),
        handleUserInputRequest: (request, invocation) => this.handleUserInputRequest(request, invocation),
      },
    });
  }

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing Copilot SDK client...");
    configureRestartActiveSessionCountProvider(() => this.getActiveSessions().length);
    this.client = new CopilotClient(buildCopilotClientOptions(this.deps.clientEnv));
    await this.client.start();
    console.log("[sdk] Copilot SDK client ready");
    this.sweepLeakedDisposableTitleSessions();
    void this.migrateLegacySessionTitles().catch((error) => {
      console.warn(`[sdk] Legacy session title migration failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private sweepLeakedDisposableTitleSessions(): void {
    const start = Date.now();
    try {
      const sweptIds = sweepLeakedCliSessionStoreRows({
        copilotHome: this.getCopilotHome(),
        idPrefix: DISPOSABLE_TITLE_SESSION_ID_PREFIX,
        cutoffTimestampMs: this.processStartedAtMs - SessionManager.DISPOSABLE_TITLE_SWEEP_GRACE_MS,
      });
      this.recordSpan("session.name.cleanupSweep", start, undefined, {
        result: "ok",
        count: sweptIds.length,
      });
      if (sweptIds.length > 0) {
        console.warn(`[sdk] Cleaned up ${sweptIds.length} leaked disposable title session row(s)`);
      }
    } catch (error) {
      this.recordSpan("session.name.cleanupSweep", start, undefined, {
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(`[sdk] Disposable title session sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listSessions() {
    if (!this.client) throw new Error("SessionManager not initialized");

    const now = Date.now();
    if (this.sessionListCache && (now - this.sessionListCache.timestamp) < SessionManager.SESSION_LIST_TTL) {
      return this.sessionListCache.data;
    }

    const t0 = Date.now();
    const sessions = await this.client.listSessions();
    this.recordSpan("session.listSessions", Date.now() - t0);
    this.sessionListCache = { data: sessions, timestamp: Date.now() };
    return sessions;
  }

  /** List available models from the Copilot SDK */
  async listModels() {
    if (!this.client) throw new Error("SessionManager not initialized");
    const t0 = Date.now();
    const models = await this.client.listModels();
    this.recordSpan("session.listModels", Date.now() - t0);
    return models;
  }

  /**
   * Fast session listing — reads workspace.yaml from disk instead of SDK RPC.
   * ~170ms for 4000+ sessions vs ~2500ms for SDK listSessions.
   * Async to avoid blocking the event loop during filesystem I/O.
   */
  async listSessionsFromDisk(options: { includeArchived?: boolean } = {}): Promise<any[]> {
    const includeArchived = options.includeArchived ?? true;
    const cacheKey = includeArchived ? "all" : "active";
    const now = Date.now();
    const cached = this.sessionDiskListCache.get(cacheKey);
    if (
      cached
      && cached.generation === this.sessionDiskListCacheGeneration
      && (now - cached.timestamp) < SessionManager.SESSION_DISK_LIST_TTL
    ) {
      this.recordSpan("session.listFromDisk.cache", 0, undefined, {
        result: "hit",
        includeArchived,
        count: cached.data.length,
      });
      return cached.data;
    }

    const existingBuild = this.sessionDiskListBuilds.get(cacheKey);
    if (existingBuild?.generation === this.sessionDiskListCacheGeneration) {
      const tWait = Date.now();
      const sessions = await existingBuild.promise;
      this.recordSpan("session.listFromDisk.cache", Date.now() - tWait, undefined, {
        result: "coalesced",
        includeArchived,
        count: sessions.length,
      });
      return sessions;
    }

    this.recordSpan("session.listFromDisk.cache", 0, undefined, {
      result: cached ? "stale" : "miss",
      includeArchived,
    });
    const generation = this.sessionDiskListCacheGeneration;
    const build = listSessionsFromDiskWithDeps({
      copilotHome: this.deps.copilotHome,
      sessionMetaStore: this.deps.sessionMetaStore,
      eventBusRegistry: this.deps.eventBusRegistry,
      resolveEffectiveSessionCwdFromWorkspaceYaml: (sessionId, content) =>
        this.workspaceController.resolveEffectiveSessionCwdFromWorkspaceYaml(sessionId, content),
      recordSpan: (name, duration, sessionId, metadata) => this.recordSpan(name, duration, sessionId, metadata),
      persistLastVisibleActivityAt: (sessionId, lastVisibleActivityAt) =>
        this.persistLastVisibleActivityAt(sessionId, lastVisibleActivityAt),
    }, { includeArchived }).then((sessions) => {
      if (generation === this.sessionDiskListCacheGeneration) {
        this.sessionDiskListCache.set(cacheKey, {
          data: sessions,
          timestamp: Date.now(),
          generation,
        });
      }
      return sessions;
    }).finally(() => {
      const currentBuild = this.sessionDiskListBuilds.get(cacheKey);
      if (currentBuild?.promise === build) {
        this.sessionDiskListBuilds.delete(cacheKey);
      }
    });
    this.sessionDiskListBuilds.set(cacheKey, { generation, promise: build });
    return build;
  }

  /** Invalidate the listSessions cache (call after create/delete) */
  invalidateSessionListCache(reason = "unknown"): void {
    const cacheKeys = [...this.sessionDiskListCache.keys()];
    const buildKeys = [...this.sessionDiskListBuilds.keys()];
    this.sessionListCache = null;
    this.sessionDiskListCache.clear();
    this.sessionDiskListBuilds.clear();
    this.sessionDiskListCacheGeneration += 1;
    this.recordSpan("session.listFromDisk.invalidate", 0, undefined, {
      reason,
      generation: this.sessionDiskListCacheGeneration,
      cacheKeys,
      buildKeys,
    });
  }

  private emitSessionNameChanged(sessionId: string, name: string): void {
    this.deps.eventBusRegistry.getBus(sessionId)?.emit({ type: "title_changed", title: name });
    this.deps.globalBus.emit({ type: "session:title", sessionId, title: name });
    this.invalidateSessionListCache("session:name");
  }

  private async withSessionNameRpc<T>(sessionId: string, operation: (session: any) => Promise<T>): Promise<T> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const cachedSession = this.sessionObjects.get(sessionId);
    if (cachedSession) return operation(cachedSession);

    if (!this.isSessionStatePathSegment(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.beginSessionResume(sessionId);
    let session: any | undefined;
    try {
      session = await Promise.race([
        this.client.resumeSession(sessionId, buildSessionNameResumeConfig()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("name resume timed out after 60s")), 60_000),
        ),
      ]);
      return await operation(session);
    } finally {
      try { await session?.disconnect?.(); } catch { /* best-effort */ }
      this.endSessionResume(sessionId);
      this.flushPendingSessionEviction(sessionId);
    }
  }

  async getSessionName(sessionId: string): Promise<string | undefined> {
    return this.sessionNameRpc.getSessionName(sessionId);
  }

  async setSessionName(sessionId: string, name: string, opts: SetSessionNameOptions = {}): Promise<void> {
    await this.sessionNameRpc.setSessionName(sessionId, name, opts);
  }

  maybeAutoNameSession(
    sessionId: string,
    options: { session?: any; userMessages?: string[] } = {},
  ): void {
    this.sessionNameAutogenerator.maybeAutoNameSession(sessionId, options);
  }

  async migrateLegacySessionTitles(): Promise<void> {
    await migrateLegacySessionTitlesWithDeps({
      sessionTitles: this.deps.sessionTitles,
      hasSessionOnDisk: (sessionId) => this.hasKnownPersistedSession(sessionId),
      readSessionNameFromWorkspace: (sessionId) => this.sessionNameRpc.readSessionNameFromWorkspace(sessionId),
      setSessionName: (sessionId, name, opts) => this.setSessionName(sessionId, name, opts),
      invalidateSessionListCache: (reason) => this.invalidateSessionListCache(reason),
      logger: console,
    });
  }

  async getSessionMetadata(sessionId: string) {
    if (!this.client) throw new Error("SessionManager not initialized");
    return this.client.getSessionMetadata(sessionId);
  }

  /** Probe MCP server status via SDK RPC (fire-and-forget, updates mcpStatus map) */
  private probeMcpStatus(sessionId: string, session: any): void {
    try {
      session.rpc?.mcp?.list?.()
        .then((result: any) => {
          if (result?.servers) {
            const servers: McpServerStatus[] = result.servers.map((s: any) => ({
              name: s.name,
              status: s.status ?? "unknown",
              error: s.error,
              source: s.source,
            }));
            this.mcpStatus.set(sessionId, servers);
            const sid = sessionId.slice(0, 8);
            console.log(`[sdk] [${sid}] 🔌 MCP probe: ${servers.map((s) => `${s.name}=${s.status}`).join(", ")}`);
          }
        })
        .catch(() => { /* best-effort */ });
    } catch { /* session.rpc may not exist */ }
  }

  private cacheResumedSession(sessionId: string, session: any): any {
    const current = this.sessionObjects.get(sessionId);
    if (current && current !== session) {
      try { session.disconnect?.(); } catch { /* best-effort */ }
      return current;
    }
    this.sessionObjects.set(sessionId, session);
    this.maybeAutoNameSession(sessionId, { session });
    return session;
  }

  private replaceCachedSession(sessionId: string, expectedSession: any, nextSession: any): any {
    const current = this.sessionObjects.get(sessionId);
    if (current && current !== expectedSession && current !== nextSession) {
      try { nextSession.disconnect?.(); } catch { /* best-effort */ }
      return current;
    }
    this.sessionObjects.set(sessionId, nextSession);
    return nextSession;
  }

  /** Get cached MCP status for a session, or probe live if session is cached */
  async getMcpStatus(sessionId: string): Promise<McpServerStatus[]> {
    const session = this.sessionObjects.get(sessionId);
    if (session) {
      try {
        const result = await session.rpc?.mcp?.list?.();
        if (result?.servers) {
          const servers: McpServerStatus[] = result.servers.map((s: any) => ({
            name: s.name,
            status: s.status ?? "unknown",
            error: s.error,
            source: s.source,
          }));
          this.mcpStatus.set(sessionId, servers);
          return servers;
        }
      } catch { /* fall through to cached */ }
    }
    return this.mcpStatus.get(sessionId) ?? [];
  }
  async loginMcpServer(
    sessionId: string,
    serverName: string,
    options: { forceReauth?: boolean } = {},
  ): Promise<McpLoginResult> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot authenticate MCP server for a busy session");
    }

    const requestedServerName = serverName.trim();
    if (!requestedServerName) throw new Error("MCP server name is required");

    const sid = sessionId.slice(0, 8);
    const linkedTask = this.findLinkedTask(sessionId);
    const resumeConfig = this.buildSessionConfig({
      sessionId,
      task: linkedTask,
      groupNotes: this.lookupGroupNotes(linkedTask?.groupId),
      forResume: true,
    });
    const configuredServerName = Object.keys(resumeConfig.mcpServers ?? {})
      .find((name) => name.toLocaleLowerCase() === requestedServerName.toLocaleLowerCase());
    if (!configuredServerName) {
      throw new Error(`MCP server "${requestedServerName}" is not configured for this session`);
    }

    this.beginSessionResume(sessionId);
    try {
      let session = this.sessionObjects.get(sessionId);
      if (!session) {
        console.log(`[sdk] [${sid}] Resuming session for MCP auth...`);
        session = await Promise.race([
          this.client.resumeSession(sessionId, resumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("MCP auth resume timed out after 60s")), 60_000),
          ),
        ]);
        session = this.cacheResumedSession(sessionId, session);
      }

      if (typeof session.rpc?.mcp?.oauth?.login !== "function") {
        throw new Error("MCP OAuth login is not available in this Copilot SDK build");
      }

      const result = await session.rpc.mcp.oauth.login({
        serverName: configuredServerName,
        forceReauth: options.forceReauth,
        clientName: "Copilot Bridge",
        callbackSuccessMessage: "Authentication complete. You can return to Copilot Bridge.",
      });
      const servers = await this.getMcpStatus(sessionId);
      console.log(`[sdk] [${sid}] MCP auth started for ${configuredServerName}${result?.authorizationUrl ? " (browser required)" : ""}`);
      return {
        serverName: configuredServerName,
        ...(typeof result?.authorizationUrl === "string" && result.authorizationUrl.trim()
          ? { authorizationUrl: result.authorizationUrl }
          : {}),
        servers,
      };
    } finally {
      this.endSessionResume(sessionId);
      this.flushPendingSessionEviction(sessionId);
    }
  }


  /** Get latest MCP status from any session (for settings page) */
  getLatestMcpStatus(): McpServerStatus[] {
    // Return the most recent non-empty status from any session
    for (const [, status] of this.mcpStatus) {
      if (status.length > 0) return status;
    }
    return [];
  }

  private normalizeUserInputIdentifier(value: string, fieldName: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new UserInputBrokerError("invalid_request", `${fieldName} is required`);
    }
    return normalized;
  }

  private isSessionStatePathSegment(sessionId: string): boolean {
    return sessionId !== "." && sessionId !== ".." && !sessionId.includes("/") && !sessionId.includes("\\");
  }

  private hasWorkspaceYamlOnDisk(sessionId: string): boolean {
    if (!this.isSessionStatePathSegment(sessionId)) return false;
    return existsSync(join(this.getSessionStateDir(sessionId), "workspace.yaml"));
  }

  private hasCliCatalogSession(sessionId: string): boolean {
    if (!this.isSessionStatePathSegment(sessionId)) return false;
    try {
      return this.deps.cliSessionCatalog?.hasSession(sessionId) === true;
    } catch (error) {
      console.warn(
        `[sdk] [${sessionId.slice(0, 8)}] Failed to check CLI session catalog:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  private hasKnownPersistedSession(sessionId: string): boolean {
    return this.hasCliCatalogSession(sessionId) || this.hasWorkspaceYamlOnDisk(sessionId);
  }

  private async canAddressSession(sessionId: string): Promise<boolean> {
    if (
      this.sessionObjects.has(sessionId)
      || this.runStateController.hasSessionRun(sessionId)
      || this.isSessionResuming(sessionId)
      || this.modelSwitchingSessions.has(sessionId)
      || this.userInputController.getPendingCount(sessionId) > 0
    ) {
      return true;
    }

    return this.hasKnownPersistedSession(sessionId);
  }

  async submitUserInputResponse(
    sessionId: string,
    requestId: UserInputRequestId,
    payload: unknown,
  ): Promise<{ requestId: UserInputRequestId; answer: string; wasFreeform: boolean; timestamp: string }> {
    const normalizedSessionId = this.normalizeUserInputIdentifier(sessionId, "sessionId");
    const normalizedRequestId = this.normalizeUserInputIdentifier(requestId, "requestId");

    if (!(await this.canAddressSession(normalizedSessionId))) {
      throw new UserInputBrokerError("request_not_found", "Session not found", { statusCode: 404 });
    }

    const response = this.userInputController.submitUserInputResponse(normalizedSessionId, normalizedRequestId, payload);
    const timestamp = new Date().toISOString();
    return { requestId: normalizedRequestId, ...response, timestamp };
  }

  async createSession(): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const t0 = Date.now();
    const sessionConfig = this.buildSessionConfig();
    const session = await this.client.createSession(sessionConfig);
    const duration = Date.now() - t0;

    this.sessionObjects.set(session.sessionId, session);
    this.persistSessionWorkspace(session.sessionId, sessionConfig.workingDirectory);
    this.probeMcpStatus(session.sessionId, session);
    this.invalidateSessionListCache("session:create");
    this.recordSpan("session.create", duration, session.sessionId);
    console.log(`[sdk] Created session ${session.sessionId} (${duration}ms)`);
    return { sessionId: session.sessionId };
  }

  async forkSession(sourceSessionId: string, options: { toEventId?: string } = {}): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const sourceTask = this.findLinkedTask(sourceSessionId);
    const sourceCwd = this.resolveEffectiveSessionCwd({ sessionId: sourceSessionId, task: sourceTask });
    if (typeof this.client.rpc?.sessions?.fork !== "function") {
      throw new Error("Session fork is not available in this Copilot SDK build");
    }

    const toEventId = options.toEventId?.trim();
    const params = toEventId
      ? { sessionId: sourceSessionId, toEventId }
      : { sessionId: sourceSessionId };
    const t0 = Date.now();
    const result = await this.client.rpc.sessions.fork(params);
    const duration = Date.now() - t0;
    this.persistSessionWorkspace(result.sessionId, sourceCwd);

    console.log(`[sdk] Forked session ${sourceSessionId.slice(0, 8)} → ${result.sessionId.slice(0, 8)}`);
    this.invalidateSessionListCache("session:fork");
    this.recordSpan("session.fork", duration, result.sessionId, {
      sourceSessionId,
      bounded: Boolean(toEventId),
    });
    return result;
  }

  async createTaskSession(taskId: string, taskTitle: string, workItems: WorkItemRef[], prDescriptions: string[], notes: string, cwd?: string, scheduleContext?: ScheduleContext, groupNotes?: { groupName: string; notes: string } | null): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const isPlaceholder = taskTitle === "New Task";

    // Look up the full task so the initial session context matches later resumes.
    const fullTask = this.deps.taskStore.getTask(taskId);

    const task = {
      id: taskId,
      title: taskTitle,
      kind: fullTask?.kind ?? "task",
      status: fullTask?.status ?? "active" as const,
      groupId: fullTask?.groupId,
      cwd: fullTask?.cwd ?? cwd,
      notes: notes || "",
      doneWhen: fullTask?.doneWhen,
      nextAction: fullTask?.nextAction,
      waitingOn: fullTask?.waitingOn,
      nextTouchAt: fullTask?.nextTouchAt,
      priority: 0,
      order: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionIds: [] as string[],
      workItems,
      pullRequests: [] as any[],
    };

    const t0 = Date.now();
    const sessionConfig = this.buildSessionConfig({
      task,
      isNewTask: isPlaceholder,
      prDescriptions,
      scheduleContext,
      groupNotes: groupNotes ?? this.lookupGroupNotes(fullTask?.groupId),
    });
    const session = await this.client.createSession(
      sessionConfig,
    );
    const duration = Date.now() - t0;

    this.sessionObjects.set(session.sessionId, session);
    this.persistSessionWorkspace(session.sessionId, sessionConfig.workingDirectory);
    this.probeMcpStatus(session.sessionId, session);
    this.invalidateSessionListCache("session:create-task");
    this.recordSpan("session.createTask", duration, session.sessionId, { taskId });
    console.log(`[sdk] Created task session ${session.sessionId} for "${taskTitle}" (${duration}ms)`);
    return { sessionId: session.sessionId };
  }

  // Abort an in-progress session turn
  async abortSession(sessionId: string): Promise<boolean> {
    if (!this.runStateController.hasSessionRun(sessionId)) return false;

    const runController = this.activeRunControllers.get(sessionId);
    const bus = this.deps.eventBusRegistry.getBus(sessionId);
    const getAbortContent = () => {
      const snapshot = bus?.getSnapshot();
      return snapshot?.finalContent ?? snapshot?.accumulatedContent ?? "";
    };
    if (!runController) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 Missing run controller during abort — resolving locally`);
      this.cancelPendingUserInputRequests(sessionId, "session_ended", PROMPT_DELIVERY_ABORTED_MESSAGE);
      bus?.emit({ type: "aborted", content: getAbortContent() });
      this.setSessionRunState(sessionId, "idle");
      this.flushPendingSessionEviction(sessionId);
      return true;
    }

    const session = this.sessionObjects.get(sessionId);
    if (!session) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 No session object during abort — resolving locally`);
      runController.completeAborted(getAbortContent());
      return true;
    }

    const sid = sessionId.slice(0, 8);
    console.log(`[sdk] [${sid}] 🛑 Aborting session...`);
    try {
      await session.abort();
      console.log(`[sdk] [${sid}] 🛑 Abort sent`);
      await runController.awaitAbortConfirmation(ABORT_CONFIRMATION_TIMEOUT_MS, getAbortContent);
    } catch (err) {
      console.error(`[sdk] [${sid}] 🛑 Abort failed:`, err);
      runController.completeAborted(getAbortContent());
    }
    return true;
  }

  /**
   * Save blob attachments to the session's files/ directory and convert
   * non-image attachments to SDK `file` type (path-based) so the agent
   * can access them with its tools. Images stay as `blob` for inline viewing.
   */
  private persistAndRouteAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): RoutedSdkAttachment[] | undefined {
    return persistAndRouteSessionAttachments(sessionId, attachments, {
      copilotHome: this.deps.copilotHome,
      logger: console,
    });
  }

  /** Generate a unique filename in dir, appending (1), (2) etc. if needed */
  private deduplicateFilename(dir: string, name: string): string {
    return deduplicateAttachmentFilename(dir, name);
  }

  // Fire and forget — starts work and emits events to the session's EventBus
  startWork(sessionId: string, prompt: string, attachments?: StartWorkAttachment[], options?: StartWorkOptions): void {
    this.sessionRunner.startWork(sessionId, prompt, attachments, options);
  }

  async startWorkAndWaitForDelivery(
    sessionId: string,
    prompt: string,
    attachments?: StartWorkAttachment[],
    options?: StartWorkOptions,
  ): Promise<void> {
    await this.sessionRunner.startWorkAndWaitForDelivery(sessionId, prompt, attachments, options);
  }

  startFleet(sessionId: string, prompt?: string): void {
    this.sessionRunner.startFleet(sessionId, prompt);
  }

  /** @internal Test seam — delegates to the SessionRunner. */
  _doWork(
    sessionId: string,
    prompt: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController?: SessionRunController,
    attachments?: StartWorkAttachment[],
    options?: StartWorkOptions,
  ): Promise<void> {
    return this.sessionRunner.doWork(sessionId, prompt, bus, runController, attachments, options);
  }

  async getSessionMessages(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: TransformedEntry[]; total: number; hasMore: boolean; lastVisibleActivityAt?: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const t0 = Date.now();
    const sid = sessionId.slice(0, 8);
    const linkedTask = this.findLinkedTask(sessionId);
    const msgResumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId), forResume: true });
    const tConfig = Date.now();

    // Reuse cached session object — avoids overwriting the active one in the SDK
    let session = this.sessionObjects.get(sessionId);
    let events: any[];
    let cacheHit = true;
    let resumeMs = 0;
    let getMessagesMs = 0;

    if (session) {
      console.log(`[sdk] [${sid}] Loading messages (cached session)...`);
      try {
        const tGm = Date.now();
        events = await session.getMessages();
        getMessagesMs = Date.now() - tGm;
        console.log(`[sdk] [${sid}] Loaded ${events.length} events from cached session`);
      } catch (err) {
        // Stale cache — CLI may have restarted. Evict and re-resume.
        cacheHit = false;
        console.log(`[sdk] [${sid}] Cached session stale (${err instanceof Error ? err.message : String(err)}), re-resuming...`);
        this.beginSessionResume(sessionId);
        const tResume = Date.now();
        try {
          this.sessionObjects.delete(sessionId);
          session = await Promise.race([
            this.client.resumeSession(sessionId, msgResumeConfig),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
            ),
          ]);
          resumeMs = Date.now() - tResume;
          session = this.cacheResumedSession(sessionId, session);
          const tGm = Date.now();
          events = await session.getMessages();
          getMessagesMs = Date.now() - tGm;
          console.log(`[sdk] [${sid}] Loaded ${events.length} events after re-resume`);
        } finally {
          this.endSessionResume(sessionId);
          this.flushPendingSessionEviction(sessionId);
        }
      }
    } else {
      cacheHit = false;
      console.log(`[sdk] [${sid}] Loading messages (resuming session)...`);
      this.beginSessionResume(sessionId);
      const tResume = Date.now();
      try {
        session = await Promise.race([
          this.client.resumeSession(sessionId, msgResumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
          ),
        ]);
        resumeMs = Date.now() - tResume;
        session = this.cacheResumedSession(sessionId, session);
        const tGm = Date.now();
        events = await session.getMessages();
        getMessagesMs = Date.now() - tGm;
        console.log(`[sdk] [${sid}] Loaded ${events.length} events after fresh resume`);
      } finally {
        this.endSessionResume(sessionId);
        this.flushPendingSessionEviction(sessionId);
      }
    }

    const tTransform = Date.now();
    const messages = transformEventsToMessages(events, sessionId);
    const lastVisibleActivityAt = getLastVisibleActivityAt(events, sessionId);
    this.persistLastVisibleActivityAt(sessionId, lastVisibleActivityAt);

    console.log(`[sdk] Loaded ${messages.length} messages for session ${sessionId}`);
    const transformMs = Date.now() - tTransform;
    this.recordSpan("session.getMessages", Date.now() - t0, sessionId, {
      eventCount: events.length,
      messageCount: messages.length,
      cacheHit,
      configMs: tConfig - t0,
      resumeMs,
      getMessagesMs,
      transformMs,
    });

    const total = messages.length;

    // Apply pagination: return a window of messages from the end
    if (opts?.limit != null && opts.limit > 0) {
      const end = opts.before != null ? opts.before : total;
      const start = Math.max(0, end - opts.limit);
      const sliced = messages.slice(start, end);
      return { messages: sliced, total, hasMore: start > 0, lastVisibleActivityAt };
    }

    return { messages, total, hasMore: false, lastVisibleActivityAt };
  }

  /**
   * Read messages directly from events.jsonl on disk — no SDK resume needed.
   * Returns messages instantly for the fast-load path.
   * Async to avoid blocking the event loop.
   */
  async readMessagesFromDisk(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: any[]; total: number; hasMore: boolean; lastVisibleActivityAt?: string }> {
    return readMessagesFromDiskWithDeps({
      copilotHome: this.deps.copilotHome,
      sessionMetaStore: this.deps.sessionMetaStore,
      eventBusRegistry: this.deps.eventBusRegistry,
      resolveEffectiveSessionCwdFromWorkspaceYaml: (sessionId, content) =>
        this.workspaceController.resolveEffectiveSessionCwdFromWorkspaceYaml(sessionId, content),
      recordSpan: (name, duration, sessionId, metadata) => this.recordSpan(name, duration, sessionId, metadata),
      persistLastVisibleActivityAt: (sessionId, lastVisibleActivityAt) =>
        this.persistLastVisibleActivityAt(sessionId, lastVisibleActivityAt),
    }, sessionId, opts);
  }

  /**
   * Warm a session by resuming it in the background.
   * Returns a promise that resolves when the session is ready for interaction.
   */
  async warmSession(sessionId: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("SessionManager not initialized");
    if (this.sessionObjects.has(sessionId)) {
      this.recordSpan("session.warm.alreadyCached", 0, sessionId);
      return;
    }

    const existingWarm = this.warmSessionPromises.get(sessionId);
    if (existingWarm) {
      const tWait = Date.now();
      await existingWarm;
      this.recordSpan("session.warm.coalesced", Date.now() - tWait, sessionId);
      return;
    }

    const skipReason = this.modelSwitchingSessions.has(sessionId)
      ? "model-switching"
      : this.isSessionResuming(sessionId)
        ? "resuming"
        : this.runStateController.isSessionBusy(sessionId)
          ? "running"
          : undefined;
    if (skipReason) {
      this.recordSpan("session.warm.skipped", 0, sessionId, { reason: skipReason });
      return;
    }

    const sid = sessionId.slice(0, 8);
    const t0 = Date.now();
    console.log(`[sdk] [${sid}] Warming session...`);

    const linkedTask = this.findLinkedTask(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId), forResume: true });

    const warmPromise = (async () => {
      this.beginSessionResume(sessionId);
      try {
        const session = await Promise.race([
          client.resumeSession(sessionId, resumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("warmSession timed out after 60s")), 60_000),
          ),
        ]);
        const cachedSession = this.cacheResumedSession(sessionId, session);
        this.probeMcpStatus(sessionId, cachedSession);
        this.invalidateSessionListCache("session:warm");
        this.deps.globalBus.emit({ type: "sessions:changed", sessionId });

        const duration = Date.now() - t0;
        this.recordSpan("session.warm.coldResume", duration, sessionId);
        this.recordSpan("session.warm", duration, sessionId);
        console.log(`[sdk] [${sid}] Session warm (${duration}ms)`);
      } finally {
        this.endSessionResume(sessionId);
        this.flushPendingSessionEviction(sessionId);
      }
    })();
    this.warmSessionPromises.set(sessionId, warmPromise);
    try {
      await warmPromise;
    } finally {
      if (this.warmSessionPromises.get(sessionId) === warmPromise) {
        this.warmSessionPromises.delete(sessionId);
      }
    }
  }

  /** Check if a session object is cached and ready for interaction */
  isSessionWarm(sessionId: string): boolean {
    return this.sessionObjects.has(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot delete a busy session");
    }
    let sdkDeleteError: unknown;
    this.cancelPendingUserInputRequests(
      sessionId,
      "session_ended",
      "Session was deleted before the user input request was answered",
    );
    this.evictCachedSession(sessionId);
    try {
      await this.client.deleteSession(sessionId);
    } catch (err: unknown) {
      if (isMissingSessionError(err)) {
        console.log(`[sdk] Session ${sessionId} already gone, continuing cleanup`);
      } else {
        sdkDeleteError = err;
        console.warn(`[sdk] Delete session ${sessionId} failed before local cleanup:`, err);
      }
    }
    this.deps.sessionWorkspaceStore?.deleteWorkspace(sessionId);

    // Remove the session-state directory from disk so listSessionsFromDisk() won't resurrect it
    const copilotHome = this.getCopilotHome();
    const sessionDir = join(copilotHome, "session-state", sessionId);
    try {
      await rm(sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[sdk] Failed to remove session dir ${sessionId}:`, err);
    }
    try {
      deleteCliSessionStoreRows(copilotHome, sessionId);
    } catch (err) {
      console.warn(`[sdk] Failed to remove session ${sessionId} from CLI catalog:`, err);
    }
    this.invalidateSessionListCache("session:delete:removed");
    if (sdkDeleteError) throw sdkDeleteError;

    console.log(`[sdk] Deleted session ${sessionId}`);
  }

  async reloadSession(sessionId: string): Promise<McpServerStatus[]> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot reload a busy session");
    }

    const sid = sessionId.slice(0, 8);
    const linkedTask = this.findLinkedTask(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId), forResume: true });

    this.beginSessionResume(sessionId);
    try {
      this.cancelPendingUserInputRequests(
        sessionId,
        "session_ended",
        "Session was reloaded before the user input request was answered",
      );
      this.evictCachedSession(sessionId);
      this.mcpStatus.delete(sessionId);

      console.log(`[sdk] [${sid}] Reloading session with fresh config...`);
      const session = await Promise.race([
        this.client.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("reloadSession timed out after 60s")), 60_000),
        ),
      ]);
      this.cacheResumedSession(sessionId, session);

      return this.getMcpStatus(sessionId);
    } finally {
      this.endSessionResume(sessionId);
      this.flushPendingSessionEviction(sessionId);
    }
  }

  isSessionBusy(sessionId: string): boolean {
    return this.modelSwitchingSessions.has(sessionId)
      || this.isSessionResuming(sessionId)
      || this.runStateController.isSessionBusy(sessionId);
  }

  getSessionRunState(sessionId: string): SessionRunState {
    if (this.modelSwitchingSessions.has(sessionId)) return "busy";
    if (this.isSessionResuming(sessionId)) return "busy";
    return this.runStateController.getSessionRunState(sessionId);
  }

  isSessionStalled(sessionId: string): boolean {
    return this.runStateController.isSessionStalled(sessionId);
  }

  getPendingUserInputCount(sessionId: string): number {
    return this.userInputController.getPendingCount(sessionId);
  }

  hasActiveTurns(): boolean {
    return this.runStateController.hasActiveTurns();
  }

  getActiveSessions(): string[] {
    return Array.from(new Set([
      ...this.runStateController.getActiveSessions(),
      ...this.resumingSessions.keys(),
      ...this.modelSwitchingSessions,
    ]));
  }

  private evictCachedSession(sessionId: string): boolean {
    const session = this.sessionObjects.get(sessionId);
    if (!session) return false;
    try { session.disconnect?.(); } catch { /* best-effort */ }
    this.sessionObjects.delete(sessionId);
    this.liveSessionModelState.delete(sessionId);
    return true;
  }

  /** Evict all cached session objects so the next turn forces a re-resume with fresh config */
  evictAllCachedSessions(): void {
    const busy = new Set(this.getActiveSessions());
    for (const id of busy) {
      this.pendingSessionEvictions.add(id);
    }
    let evicted = 0;
    for (const [id] of this.sessionObjects) {
      if (busy.has(id)) continue; // don't disrupt active turns
      if (this.evictCachedSession(id)) evicted++;
    }
    console.log(`[sdk] Evicted ${evicted} cached session(s) (${busy.size} busy, skipped)`);
  }

  /**
   * Explicitly switch the model for a single session.
   *
   * Reuses the cached session object when available; otherwise resumes with
   * forResume:true (no model/reasoningEffort in config) so the SDK loads
   * the session's own persisted model state before we apply the new model.
   * Rejects busy sessions to avoid racing with an in-progress turn.
   */
  async setSessionModel(
    sessionId: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<{ model: string; reasoningEffort?: string; modelId?: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartPending()) throw new Error("Cannot switch model while a restart is pending");
    if (this.isSessionBusy(sessionId)) throw new Error("Cannot switch model on a busy session");

    const sid = sessionId.slice(0, 8);
    this.modelSwitchingSessions.add(sessionId);
    this.syncRestartWaitingIfPending();

    try {
      let session = this.sessionObjects.get(sessionId);
      if (!session) {
        const linkedTask = this.findLinkedTask(sessionId);
        const resumeConfig = this.buildSessionConfig({
          sessionId,
          task: linkedTask,
          groupNotes: this.lookupGroupNotes(linkedTask?.groupId),
          forResume: true,
        });
        this.beginSessionResume(sessionId);
        try {
          session = await Promise.race([
            this.client.resumeSession(sessionId, resumeConfig),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
            ),
          ]);
          session = this.cacheResumedSession(sessionId, session);
          this.probeMcpStatus(sessionId, session);
        } finally {
          this.endSessionResume(sessionId);
        }
      }

      const eventsState = deriveModelStateFromEventsFile(this.getSessionEventsPath(sessionId));
      const liveState = this.liveSessionModelState.get(sessionId);
      let currentModelBeforeSwitch: string | undefined;
      if (reasoningEffort === undefined && liveState?.reasoningEffort !== undefined) {
        try {
          const current = await session.rpc?.model?.getCurrent?.();
          currentModelBeforeSwitch = current?.modelId;
        } catch { /* best-effort */ }
      }
      const knownLiveReasoningEffort =
        liveState && (!currentModelBeforeSwitch || liveState.model === currentModelBeforeSwitch)
          ? liveState.reasoningEffort
          : undefined;
      const effectiveReasoningEffort = reasoningEffort
        ?? knownLiveReasoningEffort
        ?? eventsState.reasoningEffort;
      const opts = effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : undefined;
      await session.setModel(model, opts);
      console.log(`[sdk] [${sid}] setSessionModel(${model}${effectiveReasoningEffort ? `, ${effectiveReasoningEffort}` : ""})`);

      let modelId: string | undefined;
      try {
        const current = await session.rpc?.model?.getCurrent?.();
        modelId = current?.modelId;
      } catch { /* best-effort */ }

      const liveModel = modelId ?? model;
      this.liveSessionModelState.set(sessionId, {
        model: liveModel,
        ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
      });

      return {
        model,
        ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
        ...(modelId ? { modelId } : {}),
      };
    } finally {
      this.modelSwitchingSessions.delete(sessionId);
      this.syncRestartWaitingIfPending();
      this.flushPendingSessionEviction(sessionId);
    }
  }

  /**
   * Return the current model / reasoning effort for a session on demand.
   *
   * - For active (cached) sessions, calls rpc.model.getCurrent() for the live
   *   modelId, then uses the latest explicit switch state or events.jsonl for
   *   reasoningEffort (the RPC only exposes modelId, not reasoningEffort).
   * - For inactive sessions (not in cache), falls back entirely to events.jsonl.
   * - Returns source='live' when the live RPC was used, 'events' when only the
   *   event log was used, or 'unknown' if neither had useful data.
   */
  async getSessionModelState(
    sessionId: string,
  ): Promise<{ model?: string; reasoningEffort?: string; source: "live" | "events" | "unknown" }> {
    const eventsState = deriveModelStateFromEventsFile(this.getSessionEventsPath(sessionId));

    const cached = this.sessionObjects.get(sessionId);
    if (cached) {
      try {
        const current = await cached.rpc?.model?.getCurrent?.();
        const liveModelId: string | undefined = current?.modelId;
        if (liveModelId) {
          const liveState = this.liveSessionModelState.get(sessionId);
          const reasoningEffort = liveState?.model === liveModelId
            ? liveState.reasoningEffort
            : eventsState.reasoningEffort;
          return {
            model: liveModelId,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            source: "live",
          };
        }
      } catch { /* best-effort */ }
    }

    if (eventsState.model !== undefined || eventsState.reasoningEffort !== undefined) {
      return { ...eventsState, source: "events" };
    }

    return { source: "unknown" };
  }

  getSessionActivity(): SessionActivity[] {
    return this.runStateController.getSessionActivity();
  }

  async gracefulShutdown(): Promise<void> {
    const active = this.getActiveSessions();
    if (active.length > 0) {
      console.log(`[sdk] Graceful shutdown: aborting ${active.length} active session(s)...`);
      // Abort all active sessions in parallel
      await Promise.allSettled(
        active.map(async (sessionId) => {
          const sid = sessionId.slice(0, 8);
          try {
            if (await this.abortSession(sessionId)) {
              console.log(`[sdk] [${sid}] Aborted for shutdown`);
            }
          } catch (err) {
            console.error(`[sdk] [${sid}] Abort failed during shutdown:`, err);
          }
        }),
      );

      // Wait up to 10s for sessions to drain (they clean up in their .finally())
      const deadline = Date.now() + 10_000;
      let activeCount = this.getActiveSessions().length;
      while (activeCount > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        activeCount = this.getActiveSessions().length;
      }
      if (activeCount > 0) {
        console.log(`[sdk] ${activeCount} session(s) did not drain in time`);
      } else {
        console.log("[sdk] All sessions drained cleanly");
      }
    }

    this.cancelAllPendingUserInputRequests(
      "session_ended",
      "Session manager shut down before the user input request was answered",
    );

    if (this.deps.browserSessionStore) {
      await this.deps.browserSessionStore.closeAll();
    }

    try {
      await shutdownBridgeBrowser(getBridgeBrowserTarget(this.deps.copilotHome), this.deps.telemetryStore);
    } catch (err) {
      console.error("[browser] Primary browser shutdown failed:", err);
    }

    // Stop the SDK client
    if (this.client) {
      console.log("[sdk] Stopping Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
    console.log("[sdk] Graceful shutdown complete");
  }

  async shutdown(): Promise<void> {
    this.cancelAllPendingUserInputRequests(
      "session_ended",
      "Session manager shut down before the user input request was answered",
    );
    if (this.client) {
      console.log("[sdk] Shutting down Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
  }
}
