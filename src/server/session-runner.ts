// SessionRunner — owns the per-session run loop, live SDK event handling,
// stale-cache retry, watchdog/heartbeat, stalled-session recovery, and
// tool/sub-agent event rendering. SessionManager remains the public facade
// and delegates the run-loop concerns here.

import type { CopilotClient } from "@github/copilot-sdk";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ConnectionError, ConnectionErrors } from "vscode-jsonrpc/node.js";

import { getVisibleEventTimestamp } from "./event-transform.js";
import type { getOrCreateBus } from "./event-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { Task } from "./task-store.js";
import type { UserInputCancelReason } from "./user-input-types.js";
import {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  RESTART_PENDING_MESSAGE,
  isRestartCutoverInProgress,
  refreshRestartStateSync,
} from "./restart-controller.js";
import {
  type SessionRunKind,
  type SessionRunController,
  type SessionRunStateController,
} from "./session-run-state-controller.js";
import type { SessionUserInputController } from "./session-user-input-controller.js";
import { getToolExecutionDisplayText } from "./tool-results.js";
import type {
  RoutedSdkAttachment,
  StartWorkAttachment,
} from "./session-attachment-routing.js";
import type { SessionConfigOptions } from "./session-config-builder.js";
import {
  truncateQuietIntervalDeferTail,
  type QuietIntervalDeferTailTruncationRequest,
} from "./session-history-truncation.js";

const DEFAULT_FLEET_PROMPT = "Implement the current plan using Fleet. Run independent tracks in parallel where possible, respect dependencies in the plan, and report the results in this session.";

const SYNC_SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
const STALLED_RUN_FORCE_RELEASE_MS = 10 * 60_000;
const EXTERNAL_TOOL_WAIT_SPAN_INTERVAL_MS = 5 * 60_000;
const PERSISTED_RUN_TERMINAL_EVENT_TYPES = new Set([
  "assistant.turn_end",
  "session.idle",
  "session.error",
  "abort",
]);
const PERSISTED_RUN_DIAGNOSTIC_TERMINAL_EVENT_TYPES = new Set([
  ...PERSISTED_RUN_TERMINAL_EVENT_TYPES,
  "session.shutdown",
]);
const LIVE_RUN_TERMINAL_EVENT_TYPES = new Set([
  "session.idle",
  "session.error",
  "abort",
  "session.shutdown",
]);
const PERSISTED_RUN_RELEVANT_EVENT_TYPES = new Set([
  "user.message",
  "assistant.turn_start",
  "assistant.message",
  "assistant.message_delta",
  "assistant.streaming_delta",
  "assistant.intent",
  "assistant.turn_end",
  "tool.execution_start",
  "tool.execution_progress",
  "tool.execution_partial_result",
  "tool.execution_complete",
  "external_tool.requested",
  "external_tool.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "session.idle",
  "session.error",
  "abort",
  "session.shutdown",
]);
const LIVE_TURN_END_FOLLOWUP_EVENT_TYPES = new Set([
  "user.message",
  "assistant.turn_start",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "external_tool.requested",
  "external_tool.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
]);

type SessionEventOrigin = "live" | "live_recovered" | "persisted_recovery";

interface SessionEventHandlingContext {
  origin: SessionEventOrigin;
  recoveryReason?: string;
}

interface PersistedRunEventInfo {
  latestPersistedEventType?: string;
  latestPersistedEventAgeMs?: number;
  latestPersistedTerminalEventType?: string;
  latestPersistedTerminalEventAgeMs?: number;
}

interface ActiveExternalToolCall {
  requestId: string;
  toolCallId?: string;
  toolName?: string;
  startedAt: number;
  lastActivityAt: number;
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "not_configured" | "unknown";
  error?: string;
  source?: string;
}

export type SessionAttentionMode = "normal" | "quiet";

export interface CompletionAttentionOptions {
  done?: boolean;
  error?: boolean;
}

export interface StartWorkOptions {
  attentionMode?: SessionAttentionMode;
  completionAttention?: boolean | CompletionAttentionOptions;
  historyTruncation?: QuietIntervalDeferTailTruncationRequest;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getSyncShellInitialWaitUntil(toolName: string, args: unknown, startedAt: number): number | undefined {
  if (!SYNC_SHELL_TOOL_NAMES.has(toolName)) return undefined;
  const argRecord = asObjectRecord(args);
  if (!argRecord || argRecord.mode !== "sync") return undefined;

  const rawInitialWait = argRecord.initial_wait;
  const initialWaitSeconds = typeof rawInitialWait === "number"
    ? rawInitialWait
    : typeof rawInitialWait === "string"
      ? Number(rawInitialWait)
      : Number.NaN;
  if (!Number.isFinite(initialWaitSeconds) || initialWaitSeconds <= 0) return undefined;
  return startedAt + initialWaitSeconds * 1000;
}

function getSessionShutdownType(data: any): string | undefined {
  return typeof data?.shutdownType === "string" ? data.shutdownType.toLowerCase() : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

function isStaleCachedSessionError(error: unknown): boolean {
  if (error instanceof ConnectionError) {
    return error.code === ConnectionErrors.Closed || error.code === ConnectionErrors.Disposed;
  }
  return error instanceof Error && error.message.includes("Session not found");
}

export interface SessionRunnerDeps {
  /** Lazy accessor for the SDK client; the manager owns lifecycle. */
  getClient(): CopilotClient | null;
  /** Shared cache of CopilotSession objects (owned by SessionManager). */
  sessionObjects: Map<string, any>;
  /** Shared per-session MCP status cache (owned by SessionManager). */
  mcpStatus: Map<string, McpServerStatus[]>;
  /** Shared map of in-flight run controllers (owned by SessionManager). */
  activeRunControllers: Map<string, SessionRunController>;

  runStateController: SessionRunStateController;
  userInputController: SessionUserInputController;
  eventBusRegistry: EventBusRegistry;
  globalBus: GlobalBus;
  sessionMetaStore?: SessionMetaStore;
  telemetryStore?: TelemetryStore;
  copilotHome?: string;

  isSessionBusy(sessionId: string): boolean;
  hasPlan(sessionId: string): boolean;
  getSessionStateDir(sessionId: string): string;
  buildSessionConfig(opts?: SessionConfigOptions): any;
  findLinkedTask(sessionId: string): Task | undefined;
  lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null;
  persistAndRouteAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): RoutedSdkAttachment[] | undefined;
  cacheResumedSession(sessionId: string, session: any): any;
  replaceCachedSession(sessionId: string, expectedSession: any, nextSession: any): any;
  probeMcpStatus(sessionId: string, session: any): void;
  markCachedSessionForEviction(sessionId: string, reason: string): void;
  flushPendingSessionEviction(sessionId: string): void;
  cancelPendingUserInputRequests(
    sessionId: string,
    reason: UserInputCancelReason,
    message?: string,
  ): void;
  recordSessionAttention(sessionId: string, at?: string): void;
  invalidateSessionListCache(reason?: string): void;
  maybeAutoNameSession(
    sessionId: string,
    options: { session?: any; userMessages?: string[] },
  ): void;
}

export class SessionRunner {
  constructor(private readonly deps: SessionRunnerDeps) {}

  private get client(): CopilotClient | null {
    return this.deps.getClient();
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

  private recordSessionAttention(sessionId: string, at?: string): void {
    try {
      this.deps.recordSessionAttention(sessionId, at);
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to persist attention activity:`, err);
    }
  }

  private touchSessionRun(sessionId: string, at = Date.now()): void {
    this.deps.runStateController.touchSessionRun(sessionId, at);
  }

  private setSessionRunState(
    sessionId: string,
    state: "busy" | "stalled" | "idle",
    opts: { now?: number; lastEventAt?: number; emitIdle?: boolean } = {},
  ): void {
    this.deps.runStateController.setSessionRunState(sessionId, state, opts);
  }

  private createRunController(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
  ): SessionRunController {
    return this.deps.runStateController.createRunController(sessionId, bus);
  }

  startWorkRun(
    sessionId: string,
    prompt: string,
    attachments?: StartWorkAttachment[],
    options: StartWorkOptions = {},
  ): SessionRunController {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    if (this.deps.isSessionBusy(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    bus.reset();
    bus.setPendingPrompt(prompt);
    return this.startBackgroundRun(
      sessionId,
      bus,
      (runController) => this.doWork(sessionId, prompt, bus, runController, attachments, options),
      {
        runKind: "message",
        pendingPrompt: prompt,
        promptAccepted: false,
      },
    );
  }

  startWork(sessionId: string, prompt: string, attachments?: StartWorkAttachment[], options?: StartWorkOptions): void {
    this.startWorkRun(sessionId, prompt, attachments, options);
  }

  async startWorkAndWaitForDelivery(
    sessionId: string,
    prompt: string,
    attachments?: StartWorkAttachment[],
    options?: StartWorkOptions,
  ): Promise<void> {
    const runController = this.startWorkRun(sessionId, prompt, attachments, options);
    const delivery = await runController.promptDelivery;
    if (delivery.status === "accepted") return;
    throw new Error(delivery.message);
  }

  async steerSession(sessionId: string, prompt: string, attachments?: StartWorkAttachment[]): Promise<void> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const runState = this.deps.runStateController.getSessionRunState(sessionId);
    if (runState === "idle") {
      if (this.deps.isSessionBusy(sessionId)) {
        throw new Error("Session is busy but not accepting steering right now; try again shortly");
      }
      throw new Error("Session is not busy; send a normal message instead");
    }
    if (runState === "stalled") {
      throw new Error("Session is stalled and cannot be steered; stop it or wait for recovery");
    }

    const runController = this.deps.activeRunControllers.get(sessionId);
    if (!runController || runController.isCompleted()) {
      throw new Error("Session is not accepting steering right now");
    }

    const session = this.deps.sessionObjects.get(sessionId);
    if (!session) {
      throw new Error("Session is still reconnecting; try again shortly");
    }

    const sid = sessionId.slice(0, 8);
    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    const sdkAttachments = this.deps.persistAndRouteAttachments(sessionId, attachments);
    const attachCount = sdkAttachments?.length ?? 0;
    const t0 = Date.now();
    console.log(`[sdk] [${sid}] Steering prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`);

    bus.setPendingPrompt(prompt);
    this.touchSessionRun(sessionId);
    try {
      await session.send({
        prompt,
        ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}),
        mode: "immediate",
      });
      if (runController.isCompleted()) {
        bus.clearPendingPrompt(prompt);
        throw new Error("Session ended before steering could attach; send a normal message instead");
      }
      this.touchSessionRun(sessionId);
      this.recordSpan("session.steer", Date.now() - t0, sessionId, {
        chars: prompt.length,
        attachments: attachCount,
      });
    } catch (error) {
      bus.clearPendingPrompt(prompt);
      throw error;
    }
  }

  startFleet(sessionId: string, prompt?: string): void {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (!this.deps.hasPlan(sessionId)) {
      throw new Error("Session has no plan to run with Fleet");
    }
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }
    if (this.deps.isSessionBusy(sessionId)) {
      throw new Error("Session is busy processing another request");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    bus.reset();
    const fleetPrompt = prompt?.trim() || DEFAULT_FLEET_PROMPT;
    this.startBackgroundRun(
      sessionId,
      bus,
      (runController) => this.doFleet(sessionId, fleetPrompt, bus, runController),
      {
        runKind: "fleet",
        pendingPrompt: fleetPrompt,
        promptAccepted: false,
      },
    );
  }

  private startBackgroundRun(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runner: (runController: SessionRunController) => Promise<void>,
    metadata?: {
      runKind?: SessionRunKind;
      pendingPrompt?: string;
      promptAccepted?: boolean;
    },
  ): SessionRunController {
    const now = Date.now();
    const runController = this.createRunController(sessionId, bus);
    this.deps.activeRunControllers.set(sessionId, runController);
    this.setSessionRunState(sessionId, "busy", { now, lastEventAt: now });
    if (metadata) {
      this.deps.runStateController.setSessionRunMetadata(sessionId, metadata);
    }

    runner(runController).catch((err) => {
      console.error(`[sdk] Unhandled error in session ${sessionId}:`, err);
      runController.completeError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      runController.clearAbortWait();
      this.deps.cancelPendingUserInputRequests(
        sessionId,
        "session_ended",
        "Session operation ended before the user input request was answered",
      );
      if (this.deps.activeRunControllers.get(sessionId) === runController) {
        this.deps.activeRunControllers.delete(sessionId);
      }
      this.setSessionRunState(sessionId, "idle", {
      });
      this.deps.flushPendingSessionEviction(sessionId);
    });
    return runController;
  }

  async doWork(
    sessionId: string,
    prompt: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController?: SessionRunController,
    attachments?: StartWorkAttachment[],
    options: StartWorkOptions = {},
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);
    const sdkAttachments = this.deps.persistAndRouteAttachments(sessionId, attachments);
    const attachCount = sdkAttachments?.length ?? 0;
    const activeRunController = runController ?? this.createRunController(sessionId, bus);

    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "message",
      attentionMode: options.attentionMode ?? "normal",
      completionAttention: options.completionAttention,
      idleSpanName: "session.sendToIdle",
      startLog: `[sdk] [${sid}] Sending prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`,
      historyTruncation: options.historyTruncation,
      execute: async (session) => {
        await session.send({ prompt, ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}) });
      },
    });
  }

  private async doFleet(
    sessionId: string,
    prompt: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController?: SessionRunController,
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);
    const activeRunController = runController ?? this.createRunController(sessionId, bus);
    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "fleet",
      idleSpanName: "session.fleetToIdle",
      startLog: `[sdk] [${sid}] Starting Fleet (${prompt.length} chars)...`,
      execute: async (session) => {
        if (typeof session.rpc?.fleet?.start !== "function") {
          throw new Error("Fleet mode is not available in this Copilot SDK build");
        }
        await session.rpc.fleet.start({ prompt });
      },
    });
  }

  private async runSessionOperation(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController: SessionRunController,
    opts: {
      resumeContext: string;
      idleSpanName: string;
      startLog: string;
      execute?: (session: any) => Promise<void>;
      attentionMode?: SessionAttentionMode;
      completionAttention?: boolean | CompletionAttentionOptions;
      historyTruncation?: QuietIntervalDeferTailTruncationRequest;
    },
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);

    const linkedTask = this.deps.findLinkedTask(sessionId);
    const resumeConfig = this.deps.buildSessionConfig({
      sessionId,
      task: linkedTask,
      groupNotes: this.deps.lookupGroupNotes(linkedTask?.groupId),
      forResume: true,
    });
    const configuredMcpServerNames = new Set(
      Object.keys(resumeConfig.mcpServers ?? {}).map((name) => name.trim().toLocaleLowerCase()),
    );
    const isConfiguredMcpServer = (name: unknown): name is string =>
      typeof name === "string"
      && configuredMcpServerNames.has(name.trim().toLocaleLowerCase());

    if (linkedTask) {
      console.log(`[sdk] [${sid}] Injecting task context for "${linkedTask.title}"`);
    }

    let usedCache = false;
    const resumeSession = async (): Promise<any> => {
      const resumeStart = Date.now();
      let s = this.deps.sessionObjects.get(sessionId);
      if (s) {
        usedCache = true;
        console.log(`[sdk] [${sid}] Reusing cached session object`);
      } else {
        usedCache = false;
        console.log(`[sdk] [${sid}] Resuming session...`);
        s = await Promise.race([
          this.client!.resumeSession(sessionId, resumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
          ),
        ]);
        s = this.deps.cacheResumedSession(sessionId, s);
        this.deps.probeMcpStatus(sessionId, s);
        const resumeDuration = Date.now() - resumeStart;
        this.recordSpan("session.resume", resumeDuration, sessionId, { context: opts.resumeContext });
        console.log(`[sdk] [${sid}] Session resumed (${resumeDuration}ms)`);
      }
      return s;
    };

    const abandonSession = (activeSession: any) => {
      try { activeSession.disconnect?.(); } catch { /* best-effort */ }
      if (this.deps.sessionObjects.get(sessionId) === activeSession) {
        this.deps.sessionObjects.delete(sessionId);
      }
    };

    let session = await resumeSession();
    if (runController.isCompleted()) {
      abandonSession(session);
      return;
    }

    const runStepOrCompletion = async <T>(
      stepName: string,
      step: () => Promise<T>,
    ): Promise<{ completed: true } | { completed: false; value: T }> => {
      if (runController.isCompleted()) return { completed: true };
      let stepPromise: Promise<T>;
      try {
        stepPromise = step();
      } catch (error) {
        throw error;
      }
      const stepResult = stepPromise.then(
        (value) => ({ type: "step" as const, value }),
        (error) => ({ type: "error" as const, error }),
      );
      const result = await Promise.race([
        stepResult,
        runController.completion.then(() => ({ type: "completed" as const })),
      ]);
      if (result.type === "completed") {
        const graceResult = await Promise.race([
          stepResult,
          Promise.resolve().then(() => ({ type: "timeout" as const })),
        ]);
        if (graceResult.type === "step") return { completed: false, value: graceResult.value };
        if (graceResult.type === "error") throw graceResult.error;
        void stepPromise.catch((error) => {
          console.warn(`[sdk] [${sid}] ${stepName} rejected after run completion:`, error);
        });
        console.warn(`[sdk] [${sid}] ${stepName} still pending after run completion — abandoning cached session`);
        abandonSession(session);
        return { completed: true };
      }
      if (result.type === "error") throw result.error;
      return { completed: false, value: result.value };
    };

    const toolNameMap = new Map<string, string>();
    const toolStartTimes = new Map<string, number>();
    const subAgentMap = new Map<string, string>();
    const subAgentResponseMap = new Map<string, string>();
    const activeExternalTools = new Map<string, ActiveExternalToolCall>();
    let lastExternalToolWaitSpanAt = 0;
    const rememberToolName = (toolCallId: unknown, toolName: unknown): string | undefined => {
      if (typeof toolName !== "string") return undefined;
      const normalized = toolName.trim();
      if (!normalized) return undefined;
      if (typeof toolCallId === "string" && toolCallId) {
        toolNameMap.set(toolCallId, normalized);
      }
      return normalized;
    };
    const getTrackedToolDisplayName = (toolCallId: unknown, fallbackName?: string): string => {
      if (typeof toolCallId === "string" && toolCallId) {
        return subAgentMap.get(toolCallId) ?? toolNameMap.get(toolCallId) ?? fallbackName ?? "unknown";
      }
      return fallbackName ?? "unknown";
    };
    const rememberExternalToolRequest = (data: any, eventAt: number) => {
      const requestId = typeof data?.requestId === "string" && data.requestId ? data.requestId : undefined;
      if (!requestId) return;
      const toolName = rememberToolName(data?.toolCallId, data?.toolName ?? data?.name);
      const toolCallId = typeof data?.toolCallId === "string" && data.toolCallId
        ? data.toolCallId
        : undefined;
      activeExternalTools.set(requestId, {
        requestId,
        startedAt: eventAt,
        lastActivityAt: eventAt,
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
      });
      if (activeExternalTools.size === 1) {
        lastExternalToolWaitSpanAt = eventAt;
      }
    };
    const clearExternalToolRequest = (requestId: unknown, eventAt: number) => {
      if (typeof requestId !== "string" || !requestId) return;
      const active = activeExternalTools.get(requestId);
      if (active) active.lastActivityAt = eventAt;
      activeExternalTools.delete(requestId);
      if (activeExternalTools.size === 0) {
        lastExternalToolWaitSpanAt = 0;
      }
    };
    const clearExternalToolsForToolCall = (toolCallId: unknown, eventAt: number) => {
      if (typeof toolCallId !== "string" || !toolCallId) return;
      for (const [requestId, active] of activeExternalTools) {
        if (active.toolCallId === toolCallId) {
          active.lastActivityAt = eventAt;
          activeExternalTools.delete(requestId);
        }
      }
      if (activeExternalTools.size === 0) {
        lastExternalToolWaitSpanAt = 0;
      }
    };
    const syncShellWaits = new Map<string, number>();
    const handledCurrentTurnEventKeys = new Set<string>();
    let lastAssistantContent: string | undefined;
    let lastEventTime = Date.now();
    let sendStart = lastEventTime;
    let lastDiskMtime: number | undefined;
    let lastLiveEventType: string | undefined;
    let lastLiveEventAt: number | undefined;
    let lastLiveEventOrigin: SessionEventOrigin | undefined;
    let liveTurnEndCount = 0;
    let lastLiveTurnEndAt: number | undefined;
    let eventsAfterLastLiveTurnEnd = 0;
    let activeEventsAfterLastLiveTurnEnd = 0;
    let staleCacheRetryCount = 0;
    let recoveryAttemptIndex = 0;
    let acceptingSessionEvents = false;
    const resetRunTelemetryState = () => {
      lastDiskMtime = undefined;
      lastLiveEventType = undefined;
      lastLiveEventAt = undefined;
      lastLiveEventOrigin = undefined;
      liveTurnEndCount = 0;
      lastLiveTurnEndAt = undefined;
      eventsAfterLastLiveTurnEnd = 0;
      activeEventsAfterLastLiveTurnEnd = 0;
    };
    const beginSend = () => {
      sendStart = Date.now();
      lastEventTime = sendStart;
      handledCurrentTurnEventKeys.clear();
      lastAssistantContent = undefined;
      activeExternalTools.clear();
      lastExternalToolWaitSpanAt = 0;
      resetRunTelemetryState();
      acceptingSessionEvents = true;
    };

    const getEventTimestampMs = (event: any): number | undefined => {
      const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
      if (typeof rawTimestamp !== "string") return undefined;
      const eventTime = Date.parse(rawTimestamp);
      return Number.isFinite(eventTime) ? eventTime : undefined;
    };
    const getEventTimestampIso = (event: any): string | undefined => {
      const eventTime = getEventTimestampMs(event);
      return eventTime === undefined ? undefined : new Date(eventTime).toISOString();
    };
    const shouldRecordCompletionAttention = (reason: "done" | "error"): boolean => {
      const attention = opts.completionAttention;
      if (attention === true) return true;
      if (!attention || typeof attention !== "object") return false;
      return reason === "done" ? attention.done === true : attention.error === true;
    };
    const recordCompletionAttention = (reason: "done" | "error", event: any) => {
      if (!shouldRecordCompletionAttention(reason)) return;
      this.recordSessionAttention(sessionId, getEventTimestampIso(event));
    };
    const getAgeMs = (now: number, at: number | undefined): number | undefined =>
      at === undefined ? undefined : Math.max(0, now - at);
    const getActiveExternalToolTelemetry = (now: number): Record<string, unknown> => {
      const active = [...activeExternalTools.values()];
      if (active.length === 0) return {};
      const oldest = active.reduce((currentOldest, candidate) =>
        candidate.startedAt < currentOldest.startedAt ? candidate : currentOldest,
      );
      const latestActivityAt = Math.max(...active.map((tool) => tool.lastActivityAt));
      const toolNames = [...new Set(active.map((tool) => tool.toolName ?? "unknown"))];
      return {
        activeExternalToolCount: active.length,
        activeExternalToolNames: toolNames,
        oldestActiveExternalToolName: oldest.toolName ?? "unknown",
        oldestActiveExternalToolRequestId: oldest.requestId,
        oldestActiveExternalToolCallId: oldest.toolCallId,
        oldestActiveExternalToolAgeMs: getAgeMs(now, oldest.startedAt),
        activeExternalToolLastActivityAgeMs: getAgeMs(now, latestActivityAt),
      };
    };
    const buildRunTelemetryMetadata = (now = Date.now()): Record<string, unknown> => ({
      runStartedAt: new Date(sendStart).toISOString(),
      elapsedMs: Math.max(0, now - sendStart),
      lastLiveEventType,
      lastLiveEventAgeMs: getAgeMs(now, lastLiveEventAt),
      lastLiveEventOrigin,
      lastEventTimeAgeMs: getAgeMs(now, lastEventTime),
      lastDiskMtimeAgeMs: getAgeMs(now, lastDiskMtime),
      liveTurnEndCount,
      lastLiveTurnEndAgeMs: getAgeMs(now, lastLiveTurnEndAt),
      eventsAfterLastLiveTurnEnd,
      activeEventsAfterLastLiveTurnEnd,
      pendingUserInputCount: this.deps.userInputController.getPendingCount(sessionId),
      staleCacheRetryCount: staleCacheRetryCount || undefined,
      ...getActiveExternalToolTelemetry(now),
    });
    const recordRunSpan = (
      name: string,
      duration: number,
      metadata: Record<string, unknown>,
      now = Date.now(),
    ) => {
      this.recordSpan(name, duration, sessionId, {
        ...buildRunTelemetryMetadata(now),
        ...metadata,
      });
    };
    const forceReleaseStalledRun = (now: number, reason: string): boolean => {
      if (runController.isCompleted()) return true;
      const record = this.deps.runStateController.getRunRecords().get(sessionId);
      const stalledAt = record?.stalledAt;
      if (!stalledAt) return false;
      const stalledForMs = now - stalledAt;
      if (stalledForMs < STALLED_RUN_FORCE_RELEASE_MS) return false;

      const message = `Session stalled for ${Math.ceil(stalledForMs / 1000)}s without recoverable SDK events; releasing run state locally.`;
      console.error(`[sdk] [${sid}] ⚠️ ${message}`);
      recordRunSpan("session.run.force_released", 0, {
        reason,
        stalledForMs,
        forceReleaseThresholdMs: STALLED_RUN_FORCE_RELEASE_MS,
      }, now);
      runController.completeError(message);
      abandonSession(session);
      return true;
    };
    const getTerminalCompletionSource = (eventType: string, origin: SessionEventOrigin): string => {
      const normalizedEventType = eventType.replace(/\./g, "_");
      if (origin === "persisted_recovery") return `persisted_${normalizedEventType}_recovery`;
      if (origin === "live_recovered") return `live_recovered_${normalizedEventType}`;
      return `live_${normalizedEventType}`;
    };
    const recordRunCompletion = (
      event: any,
      context: SessionEventHandlingContext,
      status: "done" | "error" | "aborted" | "shutdown",
      metadata: Record<string, unknown> = {},
    ) => {
      const now = Date.now();
      const eventType = typeof event?.type === "string" ? event.type : "unknown";
      recordRunSpan("session.run.complete", now - sendStart, {
        completionSource: getTerminalCompletionSource(eventType, context.origin),
        terminalEventType: eventType,
        terminalEventOrigin: context.origin,
        recoveryReason: context.recoveryReason,
        completionStatus: status,
        ...metadata,
      }, now);
    };
    const hasActiveFollowupAfterTurnEnd = () =>
      lastLiveTurnEndAt !== undefined && activeEventsAfterLastLiveTurnEnd > 0;
    const noteLiveEvent = (event: any, eventAt: number, origin: SessionEventOrigin) => {
      const eventType = typeof event?.type === "string" ? event.type : undefined;
      if (!eventType) return;
      if (lastLiveTurnEndAt !== undefined && eventType !== "assistant.turn_end" && !LIVE_RUN_TERMINAL_EVENT_TYPES.has(eventType)) {
        eventsAfterLastLiveTurnEnd += 1;
      }
      if (lastLiveTurnEndAt !== undefined && LIVE_TURN_END_FOLLOWUP_EVENT_TYPES.has(eventType)) {
        activeEventsAfterLastLiveTurnEnd += 1;
      }
      lastLiveEventType = eventType;
      lastLiveEventAt = eventAt;
      lastLiveEventOrigin = origin;
      if (eventType === "assistant.turn_end") {
        liveTurnEndCount += 1;
        lastLiveTurnEndAt = eventAt;
        eventsAfterLastLiveTurnEnd = 0;
        activeEventsAfterLastLiveTurnEnd = 0;
      }
    };

    const getEventReplayKey = (event: any): string | undefined => {
      const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
      const timestampPart = typeof rawTimestamp === "string" ? rawTimestamp : "";
      try {
        return createHash("sha1")
          .update(JSON.stringify([event?.type ?? "", timestampPart, event?.data ?? null]))
          .digest("hex");
      } catch {
        return undefined;
      }
    };

    const resolvePersistedTerminalEvent = (
      persistedTerminal: { event: any; assistantContent?: string } | null,
      reason: string,
    ): boolean => {
      if (!persistedTerminal) return false;
      if (runController.isCompleted()) return true;
      lastAssistantContent = persistedTerminal.assistantContent ?? lastAssistantContent;
      console.warn(`[sdk] [${sid}] ✅ Stall recovery found persisted ${persistedTerminal.event.type} ${reason} — resolving locally`);
      if (persistedTerminal.event.type === "assistant.turn_end") {
        const content = lastAssistantContent ?? "(no response)";
        recordRunCompletion(
          persistedTerminal.event,
          { origin: "persisted_recovery", recoveryReason: reason },
          "done",
          {
            finalContentLength: content.length,
            assistantContentKnown: lastAssistantContent !== undefined,
          },
        );
        recordCompletionAttention("done", persistedTerminal.event);
        runController.completeDone(content);
        return true;
      }
      handleEvent(persistedTerminal.event, { origin: "persisted_recovery", recoveryReason: reason });
      return true;
    };

    const handleEvent = (event: any, context: SessionEventHandlingContext) => {
      if (!acceptingSessionEvents || runController.isCompleted()) return;
      const eventAt = Date.now();
      const replayKey = getEventReplayKey(event);
      if (replayKey) handledCurrentTurnEventKeys.add(replayKey);
      if (context.origin === "live" || context.origin === "live_recovered") {
        noteLiveEvent(event, eventAt, context.origin);
      }
      const isTerminalEvent = LIVE_RUN_TERMINAL_EVENT_TYPES.has(event.type);
      if (!isTerminalEvent) {
        lastEventTime = eventAt;
        this.touchSessionRun(sessionId, eventAt);
      }
      const data = (event as any).data;
      if (opts.attentionMode !== "quiet") {
        this.persistLastVisibleActivityAt(sessionId, getVisibleEventTimestamp(event, sessionId));
      }
      switch (event.type) {
        case "user.message":
          bus.clearPendingPrompt(
            typeof data?.content === "string"
              ? data.content
              : typeof data?.prompt === "string"
                ? data.prompt
                : undefined,
          );
          runController.markPromptAccepted();
          if (typeof data?.content === "string" && !("source" in (data ?? {}))) {
            this.deps.maybeAutoNameSession(sessionId, { session, userMessages: [data.content] });
          }
          break;
        case "assistant.turn_start":
          console.log(`[sdk] [${sid}] ⏳ Turn started`);
          bus.emit({ type: "thinking" });
          break;
        case "assistant.message_delta":
          if (data?.parentToolCallId) break;
          if (data?.deltaContent) {
            bus.emit({ type: "delta", content: data.deltaContent });
          }
          break;
        case "assistant.intent":
          console.log(`[sdk] [${sid}] 🎯 Intent: ${data?.intent}`);
          bus.emit({ type: "intent", intent: data?.intent ?? "" });
          this.deps.globalBus.emit({ type: "session:intent", sessionId, intent: data?.intent ?? "" });
          break;
        case "assistant.message":
          if (data?.parentToolCallId && data?.content) {
            subAgentResponseMap.set(data.parentToolCallId, data.content);
            break;
          }
          if (data?.content) {
            console.log(`[sdk] [${sid}] ✅ Response (${data.content.length} chars)`);
            lastAssistantContent = data.content;
          }
          if (data?.toolRequests?.length) {
            bus.emit({ type: "assistant_partial", content: data.content ?? "" });
          }
          break;
        case "external_tool.requested": {
          rememberExternalToolRequest(data, eventAt);
          const toolName = getTrackedToolDisplayName(
            data?.toolCallId,
            rememberToolName(data?.toolCallId, data?.toolName ?? data?.name),
          );
          console.log(`[sdk] [${sid}] 🧰 External tool requested: ${toolName}`);
          break;
        }
        case "external_tool.completed":
          clearExternalToolRequest(data?.requestId, eventAt);
          break;
        case "tool.execution_start": {
          const toolName = data?.toolName ?? data?.name ?? "unknown";
          if (data?.toolCallId) {
            toolNameMap.set(data.toolCallId, toolName);
            toolStartTimes.set(data.toolCallId, Date.now());
            const toolStartAt = getEventTimestampMs(event) ?? eventAt;
            const syncShellWaitUntil = getSyncShellInitialWaitUntil(toolName, data?.arguments, toolStartAt);
            if (syncShellWaitUntil) syncShellWaits.set(data.toolCallId, syncShellWaitUntil);
            else syncShellWaits.delete(data.toolCallId);
          }
          const pendingAgent = data?.toolCallId ? subAgentMap.get(data.toolCallId) : undefined;
          const displayName = pendingAgent ?? toolName;
          console.log(`[sdk] [${sid}] 🔧 Tool: ${displayName}${data?.parentToolCallId ? ` (sub-agent)` : ""}`);
          bus.emit({
            type: "tool_start",
            toolCallId: data?.toolCallId,
            name: displayName,
            args: data?.arguments,
            parentToolCallId: data?.parentToolCallId,
            isSubAgent: pendingAgent ? true : undefined,
            timestamp: event.timestamp,
          });
          break;
        }
        case "tool.execution_progress":
          bus.emit({
            type: "tool_progress",
            toolCallId: data?.toolCallId,
            name: getTrackedToolDisplayName(
              data?.toolCallId,
              rememberToolName(data?.toolCallId, data?.toolName ?? data?.name),
            ),
            message: data?.progressMessage ?? "",
          });
          break;
        case "tool.execution_partial_result":
          bus.emit({
            type: "tool_output",
            toolCallId: data?.toolCallId,
            name: getTrackedToolDisplayName(
              data?.toolCallId,
              rememberToolName(data?.toolCallId, data?.toolName ?? data?.name),
            ),
            content: data?.partialOutput ?? "",
          });
          break;
        case "tool.execution_complete": {
          if (data?.toolCallId) syncShellWaits.delete(data.toolCallId);
          clearExternalToolsForToolCall(data?.toolCallId, eventAt);
          const completedToolName = toolNameMap.get(data?.toolCallId) ?? "unknown";
          const ok = data?.success !== false;
          const isAgent = subAgentMap.has(data?.toolCallId);
          const agentDisplayName = subAgentMap.get(data?.toolCallId);
          const result = getToolExecutionDisplayText(data, {
            subAgentResponse: isAgent ? subAgentResponseMap.get(data?.toolCallId) : undefined,
          });
          console.log(`[sdk] [${sid}] 🔧 Tool complete: ${isAgent ? agentDisplayName : completedToolName} (${ok ? "ok" : "failed"})`);
          const toolStart = toolStartTimes.get(data?.toolCallId);
          if (toolStart) {
            this.recordSpan("tool.execution", Date.now() - toolStart, sessionId, {
              toolName: completedToolName,
              success: ok,
              isSubAgent: isAgent || undefined,
            });
          }
          bus.emit({
            type: "tool_done",
            toolCallId: data?.toolCallId,
            name: isAgent ? agentDisplayName : completedToolName,
            result,
            success: data?.success,
            isSubAgent: isAgent || undefined,
            timestamp: event.timestamp,
          });
          break;
        }
        case "subagent.started": {
          const displayName = `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}`;
          console.log(`[sdk] [${sid}] ${displayName}`);
          if (data?.toolCallId) subAgentMap.set(data.toolCallId, displayName);
          bus.emit({
            type: "tool_update",
            toolCallId: data?.toolCallId,
            name: displayName,
            isSubAgent: true,
          });
          break;
        }
        case "subagent.completed":
        case "subagent.failed":
          break;
        case "assistant.turn_end": {
          break;
        }
        case "session.error":
          console.error(`[sdk] [${sid}] ❌ Error: ${data?.message ?? "unknown"}`);
          recordRunCompletion(event, context, "error", {
            errorMessagePresent: typeof data?.message === "string",
            errorMessageLength: typeof data?.message === "string" ? data.message.length : undefined,
          });
          recordCompletionAttention("error", event);
          runController.completeError(data?.message ?? "unknown");
          break;
        case "abort": {
          const reason = data?.reason ?? "user initiated";
          console.log(`[sdk] [${sid}] 🛑 Aborted: ${reason}`);
          const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
          recordRunCompletion(event, context, "aborted", {
            partialContentLength: partialContent.length,
            abortReasonPresent: typeof data?.reason === "string",
          });
          runController.completeAborted(partialContent);
          break;
        }
        case "session.shutdown": {
          const shutdownType = getSessionShutdownType(data);
          if (shutdownType === "error") {
            const message = data?.message ?? data?.reason ?? "session shutdown";
            console.error(`[sdk] [${sid}] ❌ Shutdown(error): ${message}`);
            recordRunCompletion(event, context, "error", {
              shutdownType,
              errorMessagePresent: typeof data?.message === "string" || typeof data?.reason === "string",
              errorMessageLength: typeof message === "string" ? message.length : undefined,
            });
            runController.completeError(message);
          } else {
            console.log(`[sdk] [${sid}] 🛑 Shutdown${shutdownType ? ` (${shutdownType})` : ""}`);
            const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
            recordRunCompletion(event, context, "shutdown", {
              shutdownType,
              partialContentLength: partialContent.length,
            });
            runController.completeShutdown(partialContent);
          }
          break;
        }
        case "session.title_changed":
          bus.emit({ type: "title_changed", title: data?.title ?? "" });
          this.deps.globalBus.emit({ type: "session:title", sessionId, title: data?.title ?? "" });
          break;
        case "session.idle": {
          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          const content = lastAssistantContent ?? "(no response)";
          if (
            (context.origin === "live" || context.origin === "live_recovered")
            && hasActiveFollowupAfterTurnEnd()
          ) {
            console.warn(
              `[sdk] [${sid}] Ignoring session idle with active follow-up after turn end (${elapsed}s)`,
            );
            recordRunSpan("session.idle.ignored_active_turn", Date.now() - sendStart, {
              idleEventOrigin: context.origin,
              ignoredIdleReason: "active_followup_after_turn_end",
              finalContentLength: content.length,
              assistantContentKnown: lastAssistantContent !== undefined,
            });
            break;
          }
          console.log(`[sdk] [${sid}] 💤 Session idle — done: ${content.length} chars (${elapsed}s)`);
          this.recordSpan(opts.idleSpanName, Date.now() - sendStart, sessionId, { chars: content.length });
          recordRunCompletion(event, context, "done", {
            finalContentLength: content.length,
            assistantContentKnown: lastAssistantContent !== undefined,
          });
          recordCompletionAttention("done", event);
          runController.completeDone(content);
          break;
        }
        case "session.mcp_servers_loaded": {
          const servers: McpServerStatus[] = (data?.servers ?? []).map((s: any) => ({
            name: s.name,
            status: s.status ?? "unknown",
            error: s.error,
            source: s.source,
          }));
          this.deps.mcpStatus.set(sessionId, servers);
          const failed = servers.filter((s) => s.status === "failed");
          if (failed.length > 0) {
            console.warn(`[sdk] [${sid}] ⚠️ MCP failures: ${failed.map((s) => `${s.name} (${s.error ?? "unknown"})`).join(", ")}`);
          }
          console.log(`[sdk] [${sid}] 🔌 MCP: ${servers.map((s) => `${s.name}=${s.status}`).join(", ")}`);
          bus.emit({ type: "mcp_status", servers });
          break;
        }
        case "session.mcp_server_status_changed": {
          const current = this.deps.mcpStatus.get(sessionId) ?? [];
          const name = data?.serverName;
          const status = data?.status ?? "unknown";
          const existing = current.find((s) => s.name === name);
          const previousStatus = existing?.status;
          if (existing) {
            existing.status = status;
            if (data?.error) existing.error = data.error;
          } else if (name) {
            current.push({ name, status, error: data?.error, source: data?.source });
          }
          this.deps.mcpStatus.set(sessionId, current);
          if (
            (context.origin === "live" || context.origin === "live_recovered")
            && previousStatus === "connected"
            && status === "not_configured"
            && isConfiguredMcpServer(name)
          ) {
            this.deps.markCachedSessionForEviction(sessionId, "mcp_status_connected_to_not_configured");
          }
          console.log(`[sdk] [${sid}] 🔌 MCP ${name}: ${status}${data?.error ? ` — ${data.error}` : ""}`);
          bus.emit({ type: "mcp_status", servers: current });
          break;
        }
        default:
          break;
      }
    };

    const subscribeToSession = (activeSession: typeof session) => {
      acceptingSessionEvents = false;
      return activeSession.on((event: any) => handleEvent(event, { origin: "live" }));
    };

    let unsub: (() => void) | undefined;

    const prepareSessionForSend = async (activeSession: typeof session) => {
      if (opts.historyTruncation?.mode !== "replace-quiet-interval-defer-tail") return;
      const result = await truncateQuietIntervalDeferTail({
        session: activeSession,
        sessionId,
        deferId: opts.historyTruncation.deferId,
        recordSpan: (name, duration, spanSessionId, metadata) => this.recordSpan(name, duration, spanSessionId, metadata),
      });
      if (result.status !== "truncated") return;
      bus.emit({
        type: "history_truncated",
        eventId: result.eventId,
        eventsRemoved: result.eventsRemoved,
      });
      this.deps.globalBus.emit({ type: "session:history-truncated", sessionId });
    };

    const cachedMcp = this.deps.mcpStatus.get(sessionId);
    if (cachedMcp?.length) {
      bus.emit({ type: "mcp_status", servers: cachedMcp });
    }

    const heartbeatLog = setInterval(() => {
      const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
      console.log(`[sdk] [${sid}] ⏳ Still working... (${elapsed}s)`);
    }, 30_000);

    const eventsJsonlPath = join(this.deps.getSessionStateDir(sessionId), "events.jsonl");

    let recoveryInProgress = false;
    let lastRecoveryAttempt = 0;

    const readLatestPersistedRunEventInfo = (now = Date.now()): PersistedRunEventInfo => {
      let raw: string;
      try {
        raw = readFileSync(eventsJsonlPath, "utf-8");
      } catch {
        return {};
      }

      let latestEventType: string | undefined;
      let latestEventAt: number | undefined;
      let latestTerminalEventType: string | undefined;
      let latestTerminalEventAt: number | undefined;

      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        const eventType = event?.type;
        if (typeof eventType !== "string" || !PERSISTED_RUN_RELEVANT_EVENT_TYPES.has(eventType)) continue;
        const eventTime = getEventTimestampMs(event);
        const minimumEventTime = sendStart;
        if (eventTime === undefined || eventTime < minimumEventTime) continue;

        latestEventType = eventType;
        latestEventAt = eventTime;
        if (PERSISTED_RUN_DIAGNOSTIC_TERMINAL_EVENT_TYPES.has(eventType)) {
          latestTerminalEventType = eventType;
          latestTerminalEventAt = eventTime;
        }
      }

      return {
        latestPersistedEventType: latestEventType,
        latestPersistedEventAgeMs: getAgeMs(now, latestEventAt),
        latestPersistedTerminalEventType: latestTerminalEventType,
        latestPersistedTerminalEventAgeMs: getAgeMs(now, latestTerminalEventAt),
      };
    };

    const readPersistedTerminalEvent = (
      options: { treatSessionShutdownAsTerminal?: boolean } = {},
    ): { event: any; assistantContent?: string } | null => {
      let raw: string;
      try {
        raw = readFileSync(eventsJsonlPath, "utf-8");
      } catch {
        return null;
      }

      let assistantContentFromDisk = lastAssistantContent;
      let latestRelevantState: "active" | "terminal" | undefined;
      let terminalEvent: any | null = null;
      let hasTurnEnd = false;
      let activeEventsAfterTurnEnd = 0;

      const markActive = (eventType: string) => {
        if (hasTurnEnd && LIVE_TURN_END_FOLLOWUP_EVENT_TYPES.has(eventType)) {
          activeEventsAfterTurnEnd += 1;
        }
        latestRelevantState = "active";
        terminalEvent = null;
      };

      const markTerminal = (event: any) => {
        latestRelevantState = "terminal";
        terminalEvent = event;
      };

      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
        const eventTime = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : Number.NaN;
        const minimumEventTime = sendStart;
        if (!Number.isFinite(eventTime) || eventTime < minimumEventTime) continue;

        const data = event?.data;
        switch (event?.type) {
          case "assistant.message":
            if (data?.parentToolCallId) break;
            if (typeof data?.content === "string") {
              assistantContentFromDisk = data.content;
            }
            markActive(event.type);
            break;
          case "user.message":
          case "assistant.turn_start":
          case "assistant.message_delta":
          case "assistant.streaming_delta":
          case "assistant.intent":
          case "tool.execution_start":
          case "tool.execution_progress":
          case "tool.execution_partial_result":
          case "tool.execution_complete":
          case "external_tool.requested":
          case "external_tool.completed":
          case "subagent.started":
          case "subagent.completed":
          case "subagent.failed":
            markActive(event.type);
            break;
          case "session.idle":
            if (hasTurnEnd && activeEventsAfterTurnEnd > 0) {
              markActive(event.type);
              break;
            }
            markTerminal(event);
            break;
          case "assistant.turn_end":
            hasTurnEnd = true;
            activeEventsAfterTurnEnd = 0;
            markTerminal(event);
            break;
          case "session.error":
          case "abort":
            markTerminal(event);
            break;
          case "session.shutdown":
            if (options.treatSessionShutdownAsTerminal !== false) {
              markTerminal(event);
            }
            break;
          default:
            break;
        }
      }

      if (latestRelevantState !== "terminal" || !terminalEvent) return null;
      return { event: terminalEvent, assistantContent: assistantContentFromDisk };
    };

    const resumeFreshRecoverySession = async (): Promise<any> => {
      const resumeStart = Date.now();
      console.log(`[sdk] [${sid}] Re-resuming session for stalled recovery...`);
      const recoveredSession = await Promise.race([
        this.client!.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
        ),
      ]);
      const resumeDuration = Date.now() - resumeStart;
      this.recordSpan("session.resume", resumeDuration, sessionId, { context: `${opts.resumeContext}:stalled-recovery` });
      console.log(`[sdk] [${sid}] Recovery session resumed (${resumeDuration}ms)`);
      return recoveredSession;
    };

    const readStalledRecoveryPersistedTerminalEvent = () => readPersistedTerminalEvent();

    const attemptStalledRecovery = async () => {
      if (recoveryInProgress) return;
      recoveryInProgress = true;
      const recoveryStartedAt = Date.now();
      const attemptIndex = ++recoveryAttemptIndex;
      lastRecoveryAttempt = recoveryStartedAt;
      const recordRecoveryOutcome = (
        outcome: string,
        metadata: Record<string, unknown> = {},
        now = Date.now(),
      ) => {
        recordRunSpan("session.run.recovery", now - recoveryStartedAt, {
          outcome,
          attemptIndex,
          ...readLatestPersistedRunEventInfo(now),
          ...metadata,
        }, now);
      };
      try {
        const persistedTerminalBeforeResume = readStalledRecoveryPersistedTerminalEvent();
        if (persistedTerminalBeforeResume) {
          if (resolvePersistedTerminalEvent(persistedTerminalBeforeResume, "before resume")) {
            recordRecoveryOutcome("resolved_persisted_terminal", {
              when: "before_resume",
              terminalEventType: persistedTerminalBeforeResume.event?.type,
            });
            return;
          }
        }

        const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
        console.warn(`[sdk] [${sid}] 🔄 Stall recovery: re-subscribing (${elapsed}s total)...`);
        const previousSession = session;
        const previousUnsub = unsub;
        const recoveredSession = await resumeFreshRecoverySession();

        if (runController.isCompleted() || this.deps.runStateController.getSessionRunState(sessionId) !== "stalled") {
          try { recoveredSession.disconnect?.(); } catch { /* best-effort */ }
          recordRecoveryOutcome("skipped_not_stalled_or_completed", {
            completed: runController.isCompleted(),
            runState: this.deps.runStateController.getSessionRunState(sessionId),
          });
          return;
        }

        const persistedTerminalAfterResume = readStalledRecoveryPersistedTerminalEvent();
        if (persistedTerminalAfterResume) {
          try { recoveredSession.disconnect?.(); } catch { /* best-effort */ }
          resolvePersistedTerminalEvent(persistedTerminalAfterResume, "after resume");
          recordRecoveryOutcome("resolved_persisted_terminal", {
            when: "after_resume",
            terminalEventType: persistedTerminalAfterResume.event?.type,
          });
          return;
        }

        const shouldIgnoreRecoveredEvent = (event: any) => {
          const eventTimestampMs = getEventTimestampMs(event);
          if (eventTimestampMs !== undefined && eventTimestampMs < sendStart) return true;
          const replayKey = getEventReplayKey(event);
          return replayKey !== undefined && handledCurrentTurnEventKeys.has(replayKey);
        };

        const recoverySession = this.deps.replaceCachedSession(sessionId, previousSession, recoveredSession);
        const bufferedRecoveredEvents: any[] = [];
        let acceptingRecoveredEvents = false;
        const recoveredUnsub = recoverySession.on((event: any) => {
          if (!acceptingRecoveredEvents) {
            bufferedRecoveredEvents.push(event);
            return;
          }
          if (shouldIgnoreRecoveredEvent(event)) return;
          handleEvent(event, { origin: "live_recovered" });
        });

        session = recoverySession;
        unsub = recoveredUnsub;
        this.deps.probeMcpStatus(sessionId, recoverySession);
        acceptingSessionEvents = true;

        try { previousUnsub?.(); } catch { /* best-effort */ }
        if (previousSession !== recoverySession) {
          try { previousSession.disconnect?.(); } catch { /* best-effort */ }
        }

        acceptingRecoveredEvents = true;
        for (const event of bufferedRecoveredEvents) {
          if (shouldIgnoreRecoveredEvent(event)) continue;
          handleEvent(event, { origin: "live_recovered" });
          if (runController.isCompleted()) break;
        }

        console.log(`[sdk] [${sid}] ✅ Stall recovery complete — listener re-attached`);
        recordRecoveryOutcome("reattached", {
          bufferedEventCount: bufferedRecoveredEvents.length,
        });
      } catch (err) {
        const persistedTerminalAfterFailedResume = readStalledRecoveryPersistedTerminalEvent();
        if (persistedTerminalAfterFailedResume && resolvePersistedTerminalEvent(persistedTerminalAfterFailedResume, "after failed resume")) {
          const errorName = err instanceof Error ? err.name.slice(0, 64).replace(/\r?\n/g, " ") : undefined;
          recordRecoveryOutcome("resolved_persisted_terminal", {
            when: "after_failed_resume",
            terminalEventType: persistedTerminalAfterFailedResume.event?.type,
            errorName,
          });
        } else {
          const errorName = err instanceof Error ? err.name.slice(0, 64).replace(/\r?\n/g, " ") : undefined;
          recordRecoveryOutcome("failed", { errorName });
          console.error(`[sdk] [${sid}] ❌ Stall recovery failed:`, err);
        }
      } finally {
        recoveryInProgress = false;
      }
    };

    const WATCHDOG_INTERVAL = 60_000;
    const WATCHDOG_TIMEOUT = 300_000;
    const RECOVERY_INTERVAL = 300_000;
    const watchdog = setInterval(() => {
      const now = Date.now();

      try {
        const fileStat = statSync(eventsJsonlPath);
        lastDiskMtime = fileStat.mtimeMs;
        if (fileStat.mtimeMs > lastEventTime) {
          this.deps.runStateController.touchSessionRunIfNewer(sessionId, fileStat.mtimeMs);
        }
      } catch { /* events.jsonl may not exist yet */ }

      let syncShellWaitUntil = 0;
      for (const waitUntil of syncShellWaits.values()) {
        if (waitUntil > syncShellWaitUntil) syncShellWaitUntil = waitUntil;
      }
      if (syncShellWaitUntil > now) return;

      if (this.deps.userInputController.getPendingCount(sessionId) > 0) {
        lastEventTime = now;
        this.touchSessionRun(sessionId, now);
        return;
      }

      if (activeExternalTools.size > 0) {
        this.touchSessionRun(sessionId, now);
        if (now - lastExternalToolWaitSpanAt >= EXTERNAL_TOOL_WAIT_SPAN_INTERVAL_MS) {
          lastExternalToolWaitSpanAt = now;
          const activeToolNames = [...new Set([...activeExternalTools.values()].map((tool) => tool.toolName ?? "unknown"))];
          console.log(`[sdk] [${sid}] ⏳ Waiting for external tool(s): ${activeToolNames.join(", ")}`);
          recordRunSpan("session.run.waiting_on_external_tool", 0, {
            watchdogTimeoutMs: WATCHDOG_TIMEOUT,
            ...getActiveExternalToolTelemetry(now),
          }, now);
        }
        return;
      }

      if (now - lastEventTime < WATCHDOG_TIMEOUT) return;

      const currentState = this.deps.runStateController.getSessionRunState(sessionId);
      const elapsed = ((now - sendStart) / 1000).toFixed(0);

      if (currentState !== "stalled") {
        console.error(`[sdk] [${sid}] ⚠️ Watchdog: no events for ${WATCHDOG_TIMEOUT / 1000}s — marking stalled (${elapsed}s total)`);
        recordRunSpan("session.run.stalled", 0, {
          watchdogTimeoutMs: WATCHDOG_TIMEOUT,
          previousRunState: currentState,
          ...readLatestPersistedRunEventInfo(now),
        }, now);
        this.setSessionRunState(sessionId, "stalled");
        void attemptStalledRecovery();
      } else if (forceReleaseStalledRun(now, "stalled_watchdog_timeout")) {
        return;
      } else if (now - lastRecoveryAttempt >= RECOVERY_INTERVAL) {
        console.warn(`[sdk] [${sid}] ⚠️ Session still stalled — retrying recovery (${elapsed}s total)`);
        void attemptStalledRecovery();
      }
    }, WATCHDOG_INTERVAL);

    try {
      console.log(opts.startLog);

      try {
        if (runController.isCompleted()) return;
        if (!opts.execute) throw new Error("Session run is missing an execute step");
        if ((await runStepOrCompletion("prepare session for send", () => prepareSessionForSend(session))).completed) return;
        if (runController.isCompleted()) return;
        unsub = subscribeToSession(session);
        beginSend();
        if (runController.isCompleted()) return;
        if ((await runStepOrCompletion("send prompt", () => opts.execute!(session))).completed) return;
        runController.markPromptAccepted();
      } catch (operationErr) {
        if (usedCache && isStaleCachedSessionError(operationErr)) {
          console.warn(`[sdk] [${sid}] Stale cached session (${getErrorMessage(operationErr)}) — evicting and re-resuming...`);
          unsub?.();
          unsub = undefined;
          abandonSession(session);
          session = await resumeSession();
          staleCacheRetryCount += 1;
          lastEventTime = Date.now();
          sendStart = lastEventTime;
          resetRunTelemetryState();
          if (runController.isCompleted()) {
            abandonSession(session);
            return;
          }
          if ((await runStepOrCompletion("prepare session for retry", () => prepareSessionForSend(session))).completed) return;
          if (runController.isCompleted()) return;
          unsub = subscribeToSession(session);
          beginSend();
          if (runController.isCompleted()) return;
          if (!opts.execute) throw new Error("Session run is missing an execute step");
          const retryExecute = opts.execute;
          if ((await runStepOrCompletion("retry send prompt", () => retryExecute(session))).completed) return;
          runController.markPromptAccepted();
        } else {
          throw operationErr;
        }
      }

      await runController.completion;
    } finally {
      clearInterval(heartbeatLog);
      clearInterval(watchdog);
      activeExternalTools.clear();
      lastExternalToolWaitSpanAt = 0;
      syncShellWaits.clear();
      unsub?.();
    }
  }
}

// Re-exported only so SessionManager keeps a single source of truth for the
// abort confirmation message used in the standalone abort fallback path.
export { PROMPT_DELIVERY_ABORTED_MESSAGE };
