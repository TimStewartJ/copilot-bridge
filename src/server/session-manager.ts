// Copilot SDK session manager
// Universal tools — taskId is a parameter, same tools for every session

import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
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
import { createSessionTitlesStore } from "./session-titles.js";
import {
  isPromptEchoSummary,
  looksLikeExistingSessionTitle,
} from "./session-formatting.js";
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
  RESEARCH_GUIDANCE,
  STAGING_INSTRUCTIONS,
} from "./session-instructions.js";
export type { ScheduleContext, SessionConfigOptions } from "./session-config-builder.js";
export {
  formatTaskMomentumContext,
} from "./session-task-momentum.js";
export {
  buildSessionAttachmentUrlPath,
  deriveFallbackSessionTitle,
  encodeAttachmentUrlSegment,
  escapeAttachmentMarkdownText,
  escapePromptLiteral,
  escapePromptText,
  escapeUnicodeLineSeparators,
  formatPromptTag,
  formatPromptTagList,
  formatRelatedDocManifestEntry,
  isPromptEchoSummary,
  looksLikeExistingSessionTitle,
  normalizeInlineText,
  parseWorkspaceCwd,
  parseWorkspaceSummary,
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

import type { SettingsStore } from "./settings-store.js";
import type { TagStore } from "./tag-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore } from "./docs-store.js";
import type { BrowserSessionStore } from "./browser-session-store.js";
import type { McpServerConfig } from "./mcp-config.js";
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
import { SessionRunner, type McpServerStatus } from "./session-runner.js";
export type { McpServerStatus } from "./session-runner.js";
import {
  deriveModelStateFromEventsFile,
  type DerivedModelState,
} from "./session-events-model.js";
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

export interface SessionManagerDeps {
  tools: ReturnType<typeof defineTool>[];
  globalBus: GlobalBus;
  eventBusRegistry: EventBusRegistry;
  userInputBroker?: UserInputBroker;
  sessionTitles: SessionTitlesStore;
  sessionWorkspaceStore?: SessionWorkspaceStore;
  sessionMetaStore?: SessionMetaStore;
  taskStore: TaskStore;
  taskGroupStore?: TaskGroupStore;
  checklistStore?: ChecklistStore;
  settingsStore?: SettingsStore;
  tagStore?: TagStore;
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
    taskStore: ctx.taskStore,
    taskGroupStore: ctx.taskGroupStore,
    checklistStore: ctx.checklistStore,
    settingsStore: ctx.settingsStore,
    tagStore: ctx.tagStore,
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
  private client: CopilotClient | null = null;
  private deps: SessionManagerDeps;
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
  private readonly sessionRunner: SessionRunner;
  readonly sessionRuns: Map<string, SessionRunRecord>;

  // listSessions cache — avoids expensive SDK filesystem scan on every call
  private sessionListCache: { data: any[]; timestamp: number } | null = null;
  private static SESSION_LIST_TTL = 60_000; // 1 minute TTL

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
        this.invalidateSessionListCache();
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
    this.sessionRunner = new SessionRunner({
      getClient: () => this.client,
      sessionObjects: this.sessionObjects,
      mcpStatus: this.mcpStatus,
      activeRunControllers: this.activeRunControllers,
      runStateController: this.runStateController,
      userInputController: this.userInputController,
      eventBusRegistry: deps.eventBusRegistry,
      globalBus: deps.globalBus,
      sessionTitles: deps.sessionTitles,
      sessionMetaStore: deps.sessionMetaStore,
      telemetryStore: deps.telemetryStore,
      copilotHome: deps.copilotHome,
      isSessionBusy: (sessionId) => this.isSessionBusy(sessionId),
      hasPlan: (sessionId) => this.hasPlan(sessionId),
      getSessionStateDir: (sessionId) => this.getSessionStateDir(sessionId),
      buildSessionConfig: (opts) => this.buildSessionConfig(opts),
      findLinkedTask: (sessionId) => this.findLinkedTask(sessionId),
      lookupGroupNotes: (groupId) => this.lookupGroupNotes(groupId),
      hasStoredSessionTitle: (sessionId) => this.hasStoredSessionTitle(sessionId),
      hasExistingSessionTitle: (sessionId) => this.hasExistingSessionTitle(sessionId),
      persistAndRouteAttachments: (sessionId, attachments) => this.persistAndRouteAttachments(sessionId, attachments),
      cacheResumedSession: (sessionId, session) => this.cacheResumedSession(sessionId, session),
      replaceCachedSession: (sessionId, expectedSession, nextSession) =>
        this.replaceCachedSession(sessionId, expectedSession, nextSession),
      probeMcpStatus: (sessionId, session) => this.probeMcpStatus(sessionId, session),
      flushPendingSessionEviction: (sessionId) => this.flushPendingSessionEviction(sessionId),
      cancelPendingUserInputRequests: (sessionId, reason, message) =>
        this.cancelPendingUserInputRequests(sessionId, reason, message),
      invalidateSessionListCache: () => this.invalidateSessionListCache(),
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

  private getWorkspaceSummary(sessionId: string): string | undefined {
    return this.workspaceController.getWorkspaceSummary(sessionId);
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

  private getFirstUserPrompt(sessionId: string): string | undefined {
    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");
    try {
      const raw = readFileSync(eventsPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type !== "user.message") continue;
          const content = event?.data?.content ?? event?.data?.prompt;
          if (typeof content === "string" && content.trim()) return content;
        } catch {
          continue;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private hasStoredSessionTitle(sessionId: string): boolean {
    return this.deps.sessionTitles.hasTitle(sessionId);
  }

  private hasExistingSessionTitle(sessionId: string): boolean {
    const summary = this.getWorkspaceSummary(sessionId);
    if (!summary || !looksLikeExistingSessionTitle(summary)) return false;
    const firstUserPrompt = this.getFirstUserPrompt(sessionId);
    return !isPromptEchoSummary(summary, firstUserPrompt);
  }

  private shouldInjectSelfRenameGuidance(sessionId?: string): boolean {
    if (!sessionId) return true;
    return !this.hasStoredSessionTitle(sessionId) && !this.hasExistingSessionTitle(sessionId);
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
        shouldInjectSelfRenameGuidance: (sessionId) => this.shouldInjectSelfRenameGuidance(sessionId),
        handleUserInputRequest: (request, invocation) => this.handleUserInputRequest(request, invocation),
      },
    });
  }

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing Copilot SDK client...");
    configureRestartActiveSessionCountProvider(() => this.getActiveSessions().length);
    this.client = new CopilotClient(
      this.deps.clientEnv ? { env: this.deps.clientEnv } : undefined,
    );
    await this.client.start();
    this.deps.sessionTitles.loadTitles();
    console.log("[sdk] Copilot SDK client ready");
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
    return listSessionsFromDiskWithDeps({
      copilotHome: this.deps.copilotHome,
      sessionMetaStore: this.deps.sessionMetaStore,
      eventBusRegistry: this.deps.eventBusRegistry,
      parseWorkspaceSummary: (content) => this.workspaceController.parseWorkspaceSummary(content),
      resolveEffectiveSessionCwdFromWorkspaceYaml: (sessionId, content) =>
        this.workspaceController.resolveEffectiveSessionCwdFromWorkspaceYaml(sessionId, content),
      recordSpan: (name, duration, sessionId, metadata) => this.recordSpan(name, duration, sessionId, metadata),
      persistLastVisibleActivityAt: (sessionId, lastVisibleActivityAt) =>
        this.persistLastVisibleActivityAt(sessionId, lastVisibleActivityAt),
    }, options);
  }

  /** Invalidate the listSessions cache (call after create/delete) */
  invalidateSessionListCache(): void {
    this.sessionListCache = null;
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

    const sessions = await this.listSessionsFromDisk({ includeArchived: true });
    return sessions.some((session: any) => session?.sessionId === sessionId);
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
    this.invalidateSessionListCache();
    this.recordSpan("session.create", duration, session.sessionId);
    console.log(`[sdk] Created session ${session.sessionId} (${duration}ms)`);
    return { sessionId: session.sessionId };
  }

  async duplicateSession(sourceSessionId: string): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const sessionStateDir = join(copilotHome, "session-state");
    const sourceDir = join(sessionStateDir, sourceSessionId);

    if (!existsSync(sourceDir)) {
      throw new Error(`Source session directory not found: ${sourceSessionId}`);
    }

    // Create a new session through the SDK so it's properly registered with the CLI host.
    // Simply copying a directory doesn't register the session; the CLI host needs to
    // have created the session through its own session.create RPC.
    const session = await this.client.createSession(this.buildSessionConfig());
    const newId = session.sessionId;
    const destDir = join(sessionStateDir, newId);
    const sourceTask = this.findLinkedTask(sourceSessionId);
    const sourceCwd = this.resolveEffectiveSessionCwd({ sessionId: sourceSessionId, task: sourceTask });

    // Copy events.jsonl from source, rewriting the session.start event's sessionId
    const sourceEventsPath = join(sourceDir, "events.jsonl");
    if (existsSync(sourceEventsPath)) {
      const sourceContent = readFileSync(sourceEventsPath, "utf-8");
      const lines = sourceContent.split("\n");
      const rewritten = lines.map((line) => {
        if (!line.trim()) return line;
        try {
          const event = JSON.parse(line);
          if (event.type === "session.start" && event.data?.sessionId) {
            event.data.sessionId = newId;
            return JSON.stringify(event);
          }
          return line;
        } catch {
          return line;
        }
      });
      writeFileSync(join(destDir, "events.jsonl"), rewritten.join("\n"));
    }

    // Copy auxiliary files from source session
    for (const file of ["plan.md"]) {
      const src = join(sourceDir, file);
      if (existsSync(src)) cpSync(src, join(destDir, file), { force: true });
    }
    for (const dir of ["files", "research"]) {
      const src = join(sourceDir, dir);
      if (existsSync(src)) cpSync(src, join(destDir, dir), { recursive: true, force: true });
    }

    // Drop the cached session object so the next access does a fresh resume from disk,
    // picking up the copied event history.
    session.disconnect();
    this.sessionObjects.delete(newId);
    this.persistSessionWorkspace(newId, sourceCwd);

    console.log(`[sdk] Duplicated session ${sourceSessionId.slice(0, 8)} → ${newId.slice(0, 8)}`);
    this.invalidateSessionListCache();
    return { sessionId: newId };
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
    this.invalidateSessionListCache();
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
  startWork(sessionId: string, prompt: string, attachments?: StartWorkAttachment[]): void {
    this.sessionRunner.startWork(sessionId, prompt, attachments);
  }

  async startWorkAndWaitForDelivery(sessionId: string, prompt: string, attachments?: StartWorkAttachment[]): Promise<void> {
    await this.sessionRunner.startWorkAndWaitForDelivery(sessionId, prompt, attachments);
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
  ): Promise<void> {
    return this.sessionRunner.doWork(sessionId, prompt, bus, runController, attachments);
  }

  async getSessionMessages(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: TransformedEntry[]; total: number; hasMore: boolean }> {
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
    this.persistLastVisibleActivityAt(sessionId, getLastVisibleActivityAt(events, sessionId));

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
      return { messages: sliced, total, hasMore: start > 0 };
    }

    return { messages, total, hasMore: false };
  }

  /**
   * Read messages directly from events.jsonl on disk — no SDK resume needed.
   * Returns messages instantly for the fast-load path.
   * Async to avoid blocking the event loop.
   */
  async readMessagesFromDisk(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: any[]; total: number; hasMore: boolean }> {
    return readMessagesFromDiskWithDeps({
      copilotHome: this.deps.copilotHome,
      sessionMetaStore: this.deps.sessionMetaStore,
      eventBusRegistry: this.deps.eventBusRegistry,
      parseWorkspaceSummary: (content) => this.workspaceController.parseWorkspaceSummary(content),
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
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.sessionObjects.has(sessionId)) return; // already warm
    if (this.isSessionBusy(sessionId)) throw new Error("Cannot warm a busy session");

    const sid = sessionId.slice(0, 8);
    const t0 = Date.now();
    console.log(`[sdk] [${sid}] Warming session...`);

    const linkedTask = this.findLinkedTask(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId), forResume: true });

    this.beginSessionResume(sessionId);
    try {
      const session = await Promise.race([
        this.client.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("warmSession timed out after 60s")), 60_000),
        ),
      ]);
      const cachedSession = this.cacheResumedSession(sessionId, session);
      this.probeMcpStatus(sessionId, cachedSession);

      const duration = Date.now() - t0;
      this.recordSpan("session.warm", duration, sessionId);
      console.log(`[sdk] [${sid}] Session warm (${duration}ms)`);
    } finally {
      this.endSessionResume(sessionId);
      this.flushPendingSessionEviction(sessionId);
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
    this.cancelPendingUserInputRequests(
      sessionId,
      "session_ended",
      "Session was deleted before the user input request was answered",
    );
    this.evictCachedSession(sessionId);
    try {
      await this.client.deleteSession(sessionId);
    } catch (err: unknown) {
      // Tolerate "not found" errors — the session file may already be gone
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) {
        console.log(`[sdk] Session ${sessionId} already gone, continuing cleanup`);
      } else {
        throw err;
      }
    }
    this.deps.sessionWorkspaceStore?.deleteWorkspace(sessionId);
    this.invalidateSessionListCache();

    // Remove the session-state directory from disk so listSessionsFromDisk() won't resurrect it
    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const sessionDir = join(copilotHome, "session-state", sessionId);
    try {
      await rm(sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[sdk] Failed to remove session dir ${sessionId}:`, err);
    }

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
