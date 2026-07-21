// SessionRunner — owns the per-session run loop, live SDK event handling,
// stale-cache retry, watchdog/heartbeat, stalled-session recovery, and
// tool/sub-agent event rendering. SessionManager remains the public facade
// and delegates the run-loop concerns here.

import type { AgentBackend, AgentSession, AgentSlashCommandResult } from "./agent-backend/index.js";
import { stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConnectionError, ConnectionErrors } from "vscode-jsonrpc/node.js";

import { getVisibleEventTimestamp } from "./event-transform.js";
import type { getOrCreateBus } from "./event-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { GlobalBus } from "./global-bus.js";import type { SessionMetaStore } from "./session-meta-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { SessionContextStore } from "./session-context-store.js";
import type { Task } from "./task-store.js";
import type { UserInputCancelReason } from "./user-input-types.js";
import {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  RESTART_PENDING_MESSAGE,
  isRestartCutoverInProgress,
  refreshRestartStateSync,
} from "./restart-controller.js";
import {
  type SessionRunController,
  type SessionRunStateController,
} from "./session-run-state-controller.js";
import type { SessionAgentRegistry } from "./session-agent-registry.js";
import { getToolExecutionDisplayText } from "./tool-results.js";
import { createToolLoopGuard } from "./tool-loop-guard.js";
import type {
  RoutedSdkAttachment,
  StartWorkAttachment,
} from "./session-attachment-routing.js";
import type { SessionConfigOptions } from "./session-config-builder.js";
import {
  truncateQuietIntervalDeferTail,
  type QuietIntervalDeferTailTruncationRequest,
} from "./session-history-truncation.js";
import { DEFAULT_SEND_MODE, type SendMode } from "../shared/send-mode.js";
import {
  extractTerminalCompletion,
  extractTerminalCompletionFromToolCall,
  type TerminalCompletion,
} from "../shared/terminal-completion.js";
import {
  createSessionContextTruncationMarker,
  getProviderTurnIdFromEvent,
  normalizeLiveSessionContextEvent,
} from "./session-context-normalizer.js";
import { resumeSessionWithTimeout } from "./session-resume-timeout.js";
import { parseSlashCommandPrompt, type ParsedSlashCommand } from "./slash-command.js";
import { getSdkEventId, getSdkTurnId } from "./sdk-event-identity.js";
import { inspectPersistedRunRecovery } from "./session-run-recovery-reader.js";


const SYNC_SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
const STALLED_RUN_FORCE_RELEASE_MS = 10 * 60_000;
const EXTERNAL_TOOL_WAIT_SPAN_INTERVAL_MS = 5 * 60_000;
const LIVE_RUN_TERMINAL_EVENT_TYPES = new Set([
  "session.idle",
  "session.task_complete",
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
  mode?: SendMode;
}

async function setSessionModeForSend(session: AgentSession, mode: string): Promise<void> {
  if (typeof session.setSendMode !== "function") {
    if (mode === DEFAULT_SEND_MODE) return;
    throw new Error("Session mode switching is not available in this Copilot SDK build");
  }
  await session.setSendMode({ mode });
}

function slashCommandResultToText(result: Extract<AgentSlashCommandResult, { kind: "text" | "completed" | "select" }>): string {
  if (result.kind === "text") return result.text;
  if (result.kind === "completed") return result.message ?? "";
  const optionLines = result.options.map((option, index) => {
    const label = option.label ?? option.value ?? `Option ${index + 1}`;
    return option.description ? `- ${label}: ${option.description}` : `- ${label}`;
  });
  return [
    `${result.title}:`,
    ...optionLines,
    "",
    "Interactive command selection is not available in Bridge yet. Re-run the command with a concrete subcommand or argument.",
  ].join("\n");
}

async function invokeSlashCommand(session: AgentSession, command: ParsedSlashCommand): Promise<AgentSlashCommandResult> {
  if (typeof session.invokeSlashCommand !== "function") {
    throw new Error("Slash command invocation is not available in this agent backend");
  }
  return session.invokeSlashCommand({ name: command.name, input: command.input });
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

export function isStaleAgentSessionError(error: unknown): boolean {
  if (error instanceof ConnectionError) {
    return error.code === ConnectionErrors.Closed || error.code === ConnectionErrors.Disposed;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\bSession not found\b/i.test(message);
}

export interface SessionResumeLease {
  sessionId: string;
  token: symbol;
}

export interface SessionRunnerDeps {
  /** Lazy accessor for the agent backend; the manager owns lifecycle. */
  getBackend(): AgentBackend | null;
  /** Shared cache of CopilotSession objects (owned by SessionManager). */
  sessionObjects: Map<string, any>;
  /** Shared per-session MCP status cache (owned by SessionManager). */
  mcpStatus: Map<string, McpServerStatus[]>;
  /** Shared map of in-flight run controllers (owned by SessionManager). */
  activeRunControllers: Map<string, SessionRunController>;
  runStateController: SessionRunStateController;
  agentRegistry: SessionAgentRegistry;
  eventBusRegistry: EventBusRegistry;
  globalBus: GlobalBus;
  sessionMetaStore?: SessionMetaStore;
  telemetryStore?: TelemetryStore;
  sessionContextStore?: SessionContextStore;
  copilotHome?: string;

  isSessionBusy(sessionId: string): boolean;
  hasPlan(sessionId: string): boolean;
  getSessionStateDir(sessionId: string): string;
  buildSessionConfig(opts?: SessionConfigOptions): any;
  awaitPendingSessionCreation(sessionId: string): Promise<any | undefined>;
  beginSessionResume(
    sessionId: string,
    sessionConfig: any,
    isCancelled?: () => boolean,
  ): Promise<SessionResumeLease | null>;
  endSessionResume(lease: SessionResumeLease): void;
  notifySessionCapacityChanged(): void;
  findLinkedTask(sessionId: string): Task | undefined;
  lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null;
  persistAndRouteAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): RoutedSdkAttachment[] | undefined;
  cacheResumedSession(sessionId: string, session: any, sessionConfig?: any): Promise<any>;
  replaceCachedSession(sessionId: string, expectedSession: any, nextSession: any): Promise<any>;
  abandonCachedSession(sessionId: string, expectedSession: any): Promise<void>;
  disposeSession(sessionId: string, session: any, reason: string): Promise<void>;
  probeMcpStatus(sessionId: string, session: any): void;
  markCachedSessionForEviction(sessionId: string, reason: string): void;
  /**
   * Queue a cached-session eviction without immediately attempting a flush.
   * The eviction is drained by the run controller's `.finally()` hook after
   * `setSessionRunState(sessionId, "idle")`, avoiding a race with in-flight
   * SDK persistence of the current turn's events. See SessionManager.deferMcpStatusSessionEviction.
   */
  deferMcpStatusSessionEviction(sessionId: string, reason: string): void;
  flushPendingSessionEviction(sessionId: string): void;
  getPendingUserInputCount(sessionId: string): number;
  getPendingInteractionCount(sessionId: string): number;
  cancelPendingUserInputRequests(
    sessionId: string,
    reason: UserInputCancelReason,
    message?: string,
  ): void;
  recordSessionAttention(sessionId: string, at?: string): void;
  touchSessionActivity?(sessionId: string, at: number): void;
  invalidateSessionListCache(reason?: string): void;
  maybeAutoNameSession(
    sessionId: string,
    options: { session?: any; userMessages?: string[] },
  ): void;
}

export class SessionRunner {
  private readonly recoveryPromises = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionRunnerDeps) {}

  async waitForRecoveryIdle(sessionId: string): Promise<void> {
    while (true) {
      const pending = this.recoveryPromises.get(sessionId);
      if (!pending) return;
      await pending;
    }
  }

  private get client(): AgentBackend | null {
    return this.deps.getBackend();
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
    this.deps.touchSessionActivity?.(sessionId, at);
  }

  /**
   * Fire-and-forget refresh of the session's background-agent registry. The
   * registry coalesces concurrent calls and only emits when counts change.
   */
  private refreshSessionAgents(sessionId: string, reason: string): void {
    void this.deps.agentRegistry.refresh(sessionId, reason);
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
    this.deps.sessionMetaStore?.clearTerminalOverlay(sessionId);
    bus.reset();
    bus.setPendingPrompt(prompt);
    return this.startBackgroundRun(
      sessionId,
      bus,
      (runController) => this.doWork(sessionId, prompt, bus, runController, attachments, options),
      {
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
    const command = parseSlashCommandPrompt(prompt);
    if (command) {
      const result = await invokeSlashCommand(session, command);
      if (result.kind === "send") {
        throw new Error(`Slash command /${command.name} cannot start a new agent turn while this session is busy`);
      }
      const text = slashCommandResultToText(result);
      if (text) {
        bus.emit({ type: "assistant_partial", content: text });
      }
      return;
    }

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

  private startBackgroundRun(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runner: (runController: SessionRunController) => Promise<void>,
    metadata?: {
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
      void this.deps.agentRegistry.reapFinishedSyncTasks(sessionId);
      this.deps.notifySessionCapacityChanged();
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
    const parsedCommand = parseSlashCommandPrompt(prompt);
    let sendPrompt = prompt;
    let displayPrompt: string | undefined;
    let mode: string = options.mode ?? DEFAULT_SEND_MODE;
    let commandResult: AgentSlashCommandResult | undefined;

    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "message",
      attentionMode: options.attentionMode ?? "normal",
      completionAttention: options.completionAttention,
      idleSpanName: "session.sendToIdle",
      startLog: `[sdk] [${sid}] Sending ${mode} prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`,
      historyTruncation: options.historyTruncation,
      execute: async (session) => {
        if (parsedCommand) {
          commandResult = await invokeSlashCommand(session, parsedCommand);
          if (commandResult.kind !== "send") {
            bus.clearPendingPrompt();
            activeRunController.markPromptAccepted();
            activeRunController.completeDone(slashCommandResultToText(commandResult));
            return;
          }
          sendPrompt = commandResult.prompt;
          displayPrompt = commandResult.displayPrompt;
          mode = commandResult.mode ?? mode;
          bus.setPendingPrompt(displayPrompt ?? sendPrompt);
          this.deps.runStateController.setSessionRunMetadata(sessionId, {
            pendingPrompt: displayPrompt ?? sendPrompt,
          });
        }
        await setSessionModeForSend(session, mode);
        await session.send({
          prompt: sendPrompt,
          ...(displayPrompt ? { displayPrompt } : {}),
          ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}),
        });
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
        s = await this.deps.awaitPendingSessionCreation(sessionId)
          ?? this.deps.sessionObjects.get(sessionId);
        if (s) {
          usedCache = true;
          console.log(`[sdk] [${sid}] Session creation completed`);
        }
      }
      if (!s) {
        usedCache = false;
        console.log(`[sdk] [${sid}] Resuming session...`);
        const resumeLease = await this.deps.beginSessionResume(
          sessionId,
          resumeConfig,
          () => runController.isCompleted(),
        );
        if (!resumeLease) return null;
        try {
          s = await resumeSessionWithTimeout(
            this.client!.resumeSession(sessionId, resumeConfig),
            "resumeSession timed out after 60s",
          );
          s = await this.deps.cacheResumedSession(sessionId, s, resumeConfig);
          this.deps.probeMcpStatus(sessionId, s);
          const resumeDuration = Date.now() - resumeStart;
          this.recordSpan("session.resume", resumeDuration, sessionId, { context: opts.resumeContext });
          console.log(`[sdk] [${sid}] Session resumed (${resumeDuration}ms)`);
        } finally {
          this.deps.endSessionResume(resumeLease);
        }
      }
      await this.deps.agentRegistry.reapFinishedSyncTasks(sessionId);
      return s;
    };

    const abandonSession = (activeSession: any) =>
      this.deps.abandonCachedSession(sessionId, activeSession);

    let session = await resumeSession();
    if (!session || runController.isCompleted()) {
      if (!session) return;
      await abandonSession(session);
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
        await abandonSession(session);
        return { completed: true };
      }
      if (result.type === "error") throw result.error;
      return { completed: false, value: result.value };
    };

    const toolNameMap = new Map<string, string>();
    const toolStartTimes = new Map<string, number>();
    const toolLoopGuard = createToolLoopGuard();
    const subAgentMap = new Map<string, string>();
    const subAgentToolCallIds = new Set<string>();
    const subAgentTurnIdMap = new Map<string, string>();
    const subAgentResponseMap = new Map<string, string>();
    const activeExternalTools = new Map<string, ActiveExternalToolCall>();
    const contextTelemetryProvider = this.client?.id ?? "copilot";
    const contextTelemetryProviderSessionId = sessionId;
    let currentBridgeTurnId: string | undefined;
    let pendingTerminalCompletion: TerminalCompletion | undefined;
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
      pendingTerminalCompletion = undefined;
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
    const publishContextSummary = (summary: ReturnType<SessionContextStore["getSummary"]>): void => {
      if (summary) bus.emit({ type: "context_update", summary });
    };
    const getSubagentContextTurnId = (data: any): string | undefined => {
      const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
      const parentToolCallId = typeof data?.parentToolCallId === "string" ? data.parentToolCallId : undefined;
      return (toolCallId ? subAgentTurnIdMap.get(toolCallId) : undefined)
        ?? (parentToolCallId ? subAgentTurnIdMap.get(parentToolCallId) : undefined);
    };
    const recordLiveContextTelemetry = (event: any): void => {
      const store = this.deps.sessionContextStore;
      if (!store) return;
      const data = event?.data;
      const subagentTurnId = getSubagentContextTurnId(data);
      const bridgeTurnId = subagentTurnId ?? currentBridgeTurnId;
      const attribution = subagentTurnId
        ? "subagent_turn"
        : bridgeTurnId
          ? "turn"
          : "session_overhead";
      const normalized = normalizeLiveSessionContextEvent(event, {
        sessionId,
        provider: contextTelemetryProvider,
        providerSessionId: contextTelemetryProviderSessionId,
        bridgeTurnId,
        providerTurnId: getProviderTurnIdFromEvent(event),
        attribution,
      });
      if (!normalized) return;
      publishContextSummary(store.recordContextEvent(normalized));
    };
    const endCurrentContextTurn = (event: any): void => {
      if (!currentBridgeTurnId) return;
      this.deps.sessionContextStore?.recordTurnEnd({
        sessionId,
        bridgeTurnId: currentBridgeTurnId,
        endedAt: getEventTimestampIso(event),
        model: typeof event?.data?.model === "string" ? event.data.model : undefined,
      });
      currentBridgeTurnId = undefined;
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
      pendingUserInputCount: this.deps.getPendingUserInputCount(sessionId),
      pendingInteractionCount: this.deps.getPendingInteractionCount(sessionId),
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
      void abandonSession(session).catch((error) => {
        console.error(`[sdk] [${sid}] Failed to reap force-released session:`, error);
      });
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
        runController.completeDone(content, {
          sourceEventId: getSdkEventId(persistedTerminal.event),
        });
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
      recordLiveContextTelemetry(event);
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
          currentBridgeTurnId = getSdkTurnId(event) ?? `turn-${randomUUID()}`;
          this.deps.sessionContextStore?.recordTurnStart({
            sessionId,
            provider: contextTelemetryProvider,
            providerSessionId: contextTelemetryProviderSessionId,
            providerTurnId: getProviderTurnIdFromEvent(event),
            bridgeTurnId: currentBridgeTurnId,
            attribution: "turn",
            startedAt: getEventTimestampIso(event),
            model: typeof data?.model === "string" ? data.model : undefined,
          });
          bus.emit({
            type: "thinking",
            turnId: currentBridgeTurnId,
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          });
          break;
        case "assistant.message_delta":
          if (data?.parentToolCallId) break;
          if (data?.deltaContent) {
            bus.emit({
              type: "delta",
              content: data.deltaContent,
              ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
            });
          }
          break;
        case "assistant.intent":
          console.log(`[sdk] [${sid}] 🎯 Intent: ${data?.intent}`);
          bus.emit({
            type: "intent",
            intent: data?.intent ?? "",
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          });
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
            bus.emit({
              type: "assistant_partial",
              content: data.content ?? "",
              timestamp: event.timestamp,
              ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
            });
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
          const loopCandidate = toolLoopGuard.detectCandidate(toolName, data?.arguments);
          if (loopCandidate) {
            console.warn(
              `[sdk] [${sid}] 🔍 tool-loop candidate: ${toolName} (${loopCandidate.reason}: ${loopCandidate.detail}, count=${loopCandidate.count})`,
            );
            recordRunSpan("session.run.tool_loop_candidate", 0, {
              toolName,
              loopReason: loopCandidate.reason,
              loopDetail: loopCandidate.detail,
              loopFingerprint: loopCandidate.fingerprint,
              loopCount: loopCandidate.count,
            });
          }
          if (data?.toolCallId) {
            toolNameMap.set(data.toolCallId, toolName);
            toolStartTimes.set(data.toolCallId, Date.now());
            pendingTerminalCompletion = extractTerminalCompletionFromToolCall(
              toolName,
              data?.arguments,
            ) ?? pendingTerminalCompletion;
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
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
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
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
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
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
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
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          });
          if (
            typeof data?.toolCallId === "string"
            && subAgentToolCallIds.delete(data.toolCallId)
          ) {
            void this.deps.agentRegistry.reapFinishedSyncTasks(sessionId, data.toolCallId);
          }
          break;
        }
        case "subagent.started": {
          const displayName = `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}`;
          console.log(`[sdk] [${sid}] ${displayName}`);
          if (data?.toolCallId) {
            subAgentMap.set(data.toolCallId, displayName);
            subAgentToolCallIds.add(data.toolCallId);
            const subagentBridgeTurnId = `subagent-${randomUUID()}`;
            subAgentTurnIdMap.set(data.toolCallId, subagentBridgeTurnId);
            this.deps.sessionContextStore?.recordTurnStart({
              sessionId,
              provider: contextTelemetryProvider,
              providerSessionId: contextTelemetryProviderSessionId,
              providerTurnId: getProviderTurnIdFromEvent(event),
              bridgeTurnId: subagentBridgeTurnId,
              attribution: "subagent_turn",
              startedAt: getEventTimestampIso(event),
              model: typeof data?.model === "string" ? data.model : undefined,
            });
          }
          bus.emit({
            type: "tool_update",
            toolCallId: data?.toolCallId,
            name: displayName,
            isSubAgent: true,
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          });
          this.refreshSessionAgents(sessionId, "subagent.started");
          break;
        }
        case "subagent.completed":
        case "subagent.failed": {
          const subagentToolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
          const subagentBridgeTurnId = subagentToolCallId
            ? subAgentTurnIdMap.get(subagentToolCallId)
            : undefined;
          if (subagentBridgeTurnId) {
            this.deps.sessionContextStore?.recordTurnEnd({
              sessionId,
              bridgeTurnId: subagentBridgeTurnId,
              endedAt: getEventTimestampIso(event),
              model: typeof data?.model === "string" ? data.model : undefined,
            });
          }
          if (subagentToolCallId) {
            subAgentMap.delete(subagentToolCallId);
            subAgentTurnIdMap.delete(subagentToolCallId);
            subAgentResponseMap.delete(subagentToolCallId);
          }
          this.refreshSessionAgents(sessionId, event.type);
          break;
        }
        case "session.background_tasks_changed": {
          this.refreshSessionAgents(sessionId, "background_tasks_changed");
          break;
        }
        case "system.notification": {
          const kind = (data?.kind ?? {}) as { type?: string };
          if (typeof kind.type === "string" && kind.type.startsWith("agent_")) {
            this.refreshSessionAgents(sessionId, `notification:${kind.type}`);
          }
          break;
        }
        case "assistant.turn_end": {
          endCurrentContextTurn(event);
          break;
        }
        case "session.error":
          console.error(`[sdk] [${sid}] ❌ Error: ${data?.message ?? "unknown"}`);
          endCurrentContextTurn(event);
          recordRunCompletion(event, context, "error", {
            errorMessagePresent: typeof data?.message === "string",
            errorMessageLength: typeof data?.message === "string" ? data.message.length : undefined,
          });
          recordCompletionAttention("error", event);
          runController.completeError(data?.message ?? "unknown", {
            sourceEventId: getSdkEventId(event),
          });
          break;
        case "abort": {
          const reason = data?.reason ?? "user initiated";
          console.log(`[sdk] [${sid}] 🛑 Aborted: ${reason}`);
          endCurrentContextTurn(event);
          const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
          recordRunCompletion(event, context, "aborted", {
            partialContentLength: partialContent.length,
            abortReasonPresent: typeof data?.reason === "string",
          });
          runController.completeAborted(partialContent, {
            sourceEventId: getSdkEventId(event),
          });
          break;
        }
        case "session.shutdown": {
          endCurrentContextTurn(event);
          const shutdownType = getSessionShutdownType(data);
          if (shutdownType === "error") {
            const message = data?.message ?? data?.reason ?? "session shutdown";
            console.error(`[sdk] [${sid}] ❌ Shutdown(error): ${message}`);
            recordRunCompletion(event, context, "error", {
              shutdownType,
              errorMessagePresent: typeof data?.message === "string" || typeof data?.reason === "string",
              errorMessageLength: typeof message === "string" ? message.length : undefined,
            });
            runController.completeError(message, {
              sourceEventId: getSdkEventId(event),
            });
          } else {
            console.log(`[sdk] [${sid}] 🛑 Shutdown${shutdownType ? ` (${shutdownType})` : ""}`);
            const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
            recordRunCompletion(event, context, "shutdown", {
              shutdownType,
              partialContentLength: partialContent.length,
            });
            runController.completeShutdown(partialContent, {
              sourceEventId: getSdkEventId(event),
            });
          }
          break;
        }
        case "session.title_changed":
          bus.emit({ type: "title_changed", title: data?.title ?? "" });
          this.deps.globalBus.emit({ type: "session:title", sessionId, title: data?.title ?? "" });
          break;
        case "session.idle":
        case "session.task_complete": {
          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          const terminalCompletion = extractTerminalCompletion(event);
          const resolvedTerminalCompletion = terminalCompletion ?? pendingTerminalCompletion;
          const content = resolvedTerminalCompletion?.content ?? lastAssistantContent ?? "(no response)";
          if (
            (context.origin === "live" || context.origin === "live_recovered")
            && hasActiveFollowupAfterTurnEnd()
          ) {
            console.warn(
              `[sdk] [${sid}] Ignoring ${event.type} with active follow-up after turn end (${elapsed}s)`,
            );
            recordRunSpan("session.idle.ignored_active_turn", Date.now() - sendStart, {
              idleEventOrigin: context.origin,
              ignoredIdleReason: "active_followup_after_turn_end",
              finalContentLength: content.length,
              assistantContentKnown: lastAssistantContent !== undefined,
            });
            break;
          }
          console.log(`[sdk] [${sid}] 💤 ${event.type} — done: ${content.length} chars (${elapsed}s)`);
          endCurrentContextTurn(event);
          this.recordSpan(opts.idleSpanName, Date.now() - sendStart, sessionId, { chars: content.length });
          recordRunCompletion(event, context, "done", {
            finalContentLength: content.length,
            assistantContentKnown: lastAssistantContent !== undefined,
          });
          recordCompletionAttention("done", event);
          runController.completeDone(
            content,
            {
              ...(resolvedTerminalCompletion ? { terminalCompletion: resolvedTerminalCompletion } : {}),
              ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
            },
          );
          pendingTerminalCompletion = undefined;
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
            this.deps.deferMcpStatusSessionEviction(sessionId, "mcp_status_connected_to_not_configured");
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
      publishContextSummary(this.deps.sessionContextStore?.recordContextEvent(createSessionContextTruncationMarker({
        sessionId,
        provider: contextTelemetryProvider,
        providerSessionId: contextTelemetryProviderSessionId,
        eventId: result.eventId,
        eventsRemoved: result.eventsRemoved,
        candidateEventsToRemove: result.candidateEventsToRemove,
        reason: "replace-quiet-interval-defer-tail",
      })) ?? null);
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
    publishContextSummary(this.deps.sessionContextStore?.getSummary(sessionId) ?? null);

    const heartbeatLog = setInterval(() => {
      const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
      console.log(`[sdk] [${sid}] ⏳ Still working... (${elapsed}s)`);
    }, 30_000);

    const eventsJsonlPath = join(this.deps.getSessionStateDir(sessionId), "events.jsonl");

    let recoveryInProgress = false;
    let lastRecoveryAttempt = 0;

    const resumeFreshRecoverySession = async (): Promise<any> => {
      const resumeStart = Date.now();
      console.log(`[sdk] [${sid}] Re-resuming session for stalled recovery...`);
      const recoveredSession = await resumeSessionWithTimeout(
        this.client!.resumeSession(sessionId, resumeConfig),
        "resumeSession timed out after 60s",
      );
      const resumeDuration = Date.now() - resumeStart;
      this.recordSpan("session.resume", resumeDuration, sessionId, { context: `${opts.resumeContext}:stalled-recovery` });
      console.log(`[sdk] [${sid}] Recovery session resumed (${resumeDuration}ms)`);
      return recoveredSession;
    };

    const attemptStalledRecovery = async () => {
      if (recoveryInProgress) return;
      recoveryInProgress = true;
      const recoveryStartedAt = Date.now();
      const attemptIndex = ++recoveryAttemptIndex;
      lastRecoveryAttempt = recoveryStartedAt;
      const recordRecoveryOutcome = async (
        outcome: string,
        metadata: Record<string, unknown> = {},
        now = Date.now(),
      ) => {
        const inspection = await inspectPersistedRunRecovery(eventsJsonlPath, sendStart, {
          now,
          lastAssistantContent,
        });
        recordRunSpan("session.run.recovery", now - recoveryStartedAt, {
          outcome,
          attemptIndex,
          ...inspection.info,
          ...metadata,
        }, now);
      };
      try {
        const persistedTerminalBeforeResume = (
          await inspectPersistedRunRecovery(eventsJsonlPath, sendStart, { lastAssistantContent })
        ).terminal;
        if (persistedTerminalBeforeResume) {
          if (resolvePersistedTerminalEvent(persistedTerminalBeforeResume, "before resume")) {
            await recordRecoveryOutcome("resolved_persisted_terminal", {
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
          await this.deps.disposeSession(
            sessionId,
            recoveredSession,
            "discarding completed stall-recovery session",
          );
          await recordRecoveryOutcome("skipped_not_stalled_or_completed", {
            completed: runController.isCompleted(),
            runState: this.deps.runStateController.getSessionRunState(sessionId),
          });
          return;
        }

        const persistedTerminalAfterResume = (
          await inspectPersistedRunRecovery(eventsJsonlPath, sendStart, { lastAssistantContent })
        ).terminal;
        if (persistedTerminalAfterResume) {
          await this.deps.disposeSession(
            sessionId,
            recoveredSession,
            "discarding redundant stall-recovery session",
          );
          resolvePersistedTerminalEvent(persistedTerminalAfterResume, "after resume");
          await recordRecoveryOutcome("resolved_persisted_terminal", {
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

        const recoverySession = await this.deps.replaceCachedSession(sessionId, previousSession, recoveredSession);
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

        acceptingRecoveredEvents = true;
        for (const event of bufferedRecoveredEvents) {
          if (shouldIgnoreRecoveredEvent(event)) continue;
          handleEvent(event, { origin: "live_recovered" });
          if (runController.isCompleted()) break;
        }

        console.log(`[sdk] [${sid}] ✅ Stall recovery complete — listener re-attached`);
        await recordRecoveryOutcome("reattached", {
          bufferedEventCount: bufferedRecoveredEvents.length,
        });
      } catch (err) {
        const persistedTerminalAfterFailedResume = (
          await inspectPersistedRunRecovery(eventsJsonlPath, sendStart, { lastAssistantContent })
        ).terminal;
        if (persistedTerminalAfterFailedResume && resolvePersistedTerminalEvent(persistedTerminalAfterFailedResume, "after failed resume")) {
          const errorName = err instanceof Error ? err.name.slice(0, 64).replace(/\r?\n/g, " ") : undefined;
          await recordRecoveryOutcome("resolved_persisted_terminal", {
            when: "after_failed_resume",
            terminalEventType: persistedTerminalAfterFailedResume.event?.type,
            errorName,
          });
        } else {
          const errorName = err instanceof Error ? err.name.slice(0, 64).replace(/\r?\n/g, " ") : undefined;
          await recordRecoveryOutcome("failed", { errorName });
          console.error(`[sdk] [${sid}] ❌ Stall recovery failed:`, err);
        }
      } finally {
        recoveryInProgress = false;
      }
    };
    const startStalledRecovery = (relatedWork?: Promise<unknown>) => {
      const existing = this.recoveryPromises.get(sessionId);
      if (existing) return;
      const recovery = attemptStalledRecovery();
      const tracked = Promise.all([recovery, relatedWork]).then(() => undefined);
      this.recoveryPromises.set(sessionId, tracked);
      void tracked.finally(() => {
        if (this.recoveryPromises.get(sessionId) === tracked) {
          this.recoveryPromises.delete(sessionId);
        }
      });
    };

    const WATCHDOG_INTERVAL = 60_000;
    const WATCHDOG_TIMEOUT = 300_000;
    const RECOVERY_INTERVAL = 300_000;
    const runWatchdogTick = () => {
      const now = Date.now();

      void stat(eventsJsonlPath).then((fileStat) => {
        lastDiskMtime = fileStat.mtimeMs;
        if (fileStat.mtimeMs > lastEventTime) {
          this.deps.runStateController.touchSessionRunIfNewer(sessionId, fileStat.mtimeMs);
        }
      }).catch(() => { /* events.jsonl may not exist yet */ });

      let syncShellWaitUntil = 0;
      for (const waitUntil of syncShellWaits.values()) {
        if (waitUntil > syncShellWaitUntil) syncShellWaitUntil = waitUntil;
      }
      if (syncShellWaitUntil > now) return;

      if (this.deps.getPendingInteractionCount(sessionId) > 0) {
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
        this.setSessionRunState(sessionId, "stalled");
        const telemetryInspection = inspectPersistedRunRecovery(eventsJsonlPath, sendStart, {
          now,
          lastAssistantContent,
        }).then((inspection) => {
          recordRunSpan("session.run.stalled", 0, {
            watchdogTimeoutMs: WATCHDOG_TIMEOUT,
            previousRunState: currentState,
            ...inspection.info,
          }, now);
        }).catch((error) => {
          console.warn(`[sdk] [${sid}] Failed to inspect persisted events for stall telemetry:`, error);
        });
        startStalledRecovery(telemetryInspection);
      } else if (forceReleaseStalledRun(now, "stalled_watchdog_timeout")) {
        return;
      } else if (now - lastRecoveryAttempt >= RECOVERY_INTERVAL) {
        console.warn(`[sdk] [${sid}] ⚠️ Session still stalled — retrying recovery (${elapsed}s total)`);
        startStalledRecovery();
      }
    };
    const watchdog = setInterval(() => {
      runWatchdogTick();
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
        if (usedCache && isStaleAgentSessionError(operationErr)) {
          console.warn(`[sdk] [${sid}] Stale cached session (${getErrorMessage(operationErr)}) — evicting and re-resuming...`);
          unsub?.();
          unsub = undefined;
          await abandonSession(session);
          session = await resumeSession();
          staleCacheRetryCount += 1;
          lastEventTime = Date.now();
          sendStart = lastEventTime;
          resetRunTelemetryState();
          if (runController.isCompleted()) {
            await abandonSession(session);
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
