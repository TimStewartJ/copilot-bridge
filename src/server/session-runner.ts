// SessionRunner — owns the per-session run loop, live SDK event handling,
// stale-cache retry, the watchdog that asks the runtime whether a run is over, and
// tool/sub-agent event rendering. SessionManager remains the public facade
// and delegates the run-loop concerns here.

import type {
  AgentBackend,
  AgentBackgroundTask,
  AgentSession,
  AgentSlashCommandResult,
} from "./agent-backend/index.js";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConnectionError, ConnectionErrors } from "vscode-jsonrpc/node.js";

import { getVisibleEventTimestamp } from "./event-transform.js";
import { clearEventLogStatsCache } from "./session-disk-reader.js";
import type { EventBusRegistry, SessionEventBus } from "./event-bus.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { SessionContextStore } from "./session-context-store.js";
import type { Task } from "./task-store.js";
import {
  normalizePendingElicitationRequest,
  normalizePendingUserInputRequest,
} from "./pending-interaction-validation.js";
import {
  type SessionRunController,
  type SessionRunStateController,
} from "./session-run-state-controller.js";
import type { SessionAgentRegistry } from "./session-agent-registry.js";
import {
  buildSubagentInstructions,
  SubagentCorrelator,
  formatSubagentDisplayName,
  resolveToolOutcome,
} from "./subagent-correlation.js";
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
import { parseSlashCommandPrompt, type ParsedSlashCommand } from "./slash-command.js";
import {
  getAssistantTurnInstanceId,
  getSdkAgentId,
  getSdkEventId,
  getSdkTurnId,
  isSdkAgentUserMessage,
  isSdkSubagentSessionError,
} from "./sdk-event-identity.js";
import { readPersistedRunEnding, type PersistedRunEnding } from "./session-run-ending-reader.js";
import type { SessionAutoNameOptions } from "./session-name-autogen.js";
import { normalizePromptCacheBreak, promptProcessMetadata } from "./session-prompt-fingerprint.js";


const WATCHDOG_INTERVAL_MS = 60_000;
/**
 * The runtime must report a run idle twice, this far apart, before the watchdog ends it. In autopilot
 * the main agent goes idle for a moment (about 100 ms measured) before the runtime continues it.
 */
const RUN_ENDED_CONFIRM_MS = 10_000;
const NO_PROGRESS_WARNING_MS = 10 * 60_000;
const NO_PROGRESS_ABORT_MS = 60 * 60_000;
/** Silence this long (no live event, no disk progress) makes the watchdog ping the backend channel. */
const NO_PROGRESS_BACKEND_PROBE_MS = 3 * 60_000;
const SESSION_TOOL_INITIALIZATION_INCOMPLETE_MESSAGE =
  "Session tool initialization did not complete before prompt delivery";
const MCP_SESSION_RECOVERY_WINDOW_MS = 10 * 60_000;
const MCP_SESSION_RECOVERY_MAX_ATTEMPTS = 2;
const LIVE_RUN_TERMINAL_EVENT_TYPES = new Set([
  "session.idle",
  "session.task_complete",
  "session.error",
  "abort",
  "session.shutdown",
]);

/** What the runtime said when the watchdog asked whether the run is still going. */
type RuntimeAnswer = "working" | "idle" | "unknown";

const SETTLED_AGENT_TASK_STATUSES = new Set(["idle", "completed", "failed", "cancelled"]);
/** An agent the runtime will wake the main agent for. A status the Bridge does not know counts as running. */
const isRunningAgentTask = (task: AgentBackgroundTask): boolean =>
  task.kind === "agent" && !SETTLED_AGENT_TASK_STATUSES.has(task.status);

/**
 * When a background agent finishes, the runtime wakes the main agent with a notice. While other
 * background work such as an attached shell is still going, it holds that notice for 60 s (measured
 * on CLI 1.0.88). A `read_agent` by the main agent consumes it instead, and a cancelled agent sends none.
 */
const AGENT_WAKE_WINDOW_MS = 90_000;

/** A background agent that just finished and whose outcome the main agent has not heard yet. */
function awaitsWake(
  task: AgentBackgroundTask,
  reportedAt: ReadonlyMap<string, number> | undefined,
  now: number,
): boolean {
  if (task.kind !== "agent" || task.executionMode !== "background") return false;
  const settled = task.status === "idle"
    ? task.idleSince
    : task.status === "completed" || task.status === "failed" ? task.completedAt : undefined;
  const settledAt = settled ? Date.parse(settled) : Number.NaN;
  if (!Number.isFinite(settledAt) || now - settledAt > AGENT_WAKE_WINDOW_MS) return false;
  return (reportedAt?.get(task.id) ?? Number.NEGATIVE_INFINITY) < settledAt;
}

/**
 * A cached session's one event subscription. It lives as long as the session stays cached and hands
 * events to the open run, so a turn the runtime starts on its own (a background agent's wake-up,
 * autopilot) is seen even when no run is open.
 */
interface SessionFeed {
  session: AgentSession;
  unsubscribe: () => void;
  /** The open run's event handler, registered by `runSessionOperation`. */
  run?: { controller: SessionRunController; handleEvent: (event: any) => void };
  /** When the main agent last heard about each background agent: its notice or its own read_agent. */
  agentReportedAt: Map<string, number>;
  readAgentCalls: Map<string, string>;
  attentionMode: SessionAttentionMode;
  /**
   * Events from the start of a runtime-started turn, held until a run registers: the run opened
   * for it (`claimed`), or the next run when the session was busy with something else.
   */
  heldTurn?: { startedAt: number; events: unknown[]; claimed?: boolean };
}

function getEventTimestampMs(event: any): number | undefined {
  const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
  if (typeof rawTimestamp !== "string") return undefined;
  const eventTime = Date.parse(rawTimestamp);
  return Number.isFinite(eventTime) ? eventTime : undefined;
}

type SessionEventOrigin = "live" | "persisted_recovery";

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

import { stampMcpStatusSnapshot, type McpStatusProvenance } from "./mcp-status.js";
import { classifyToolFailure } from "../shared/tool-failure.js";

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "not_configured" | "unknown";
  error?: string;
  source?: string;
  observedAt?: string;
  provenance?: McpStatusProvenance;
  sessionId?: string;
}

export interface McpStatusSnapshot {
  servers: McpServerStatus[];
  complete: boolean;
  observedAt?: number;
  provenance?: McpStatusProvenance;
  sessionId?: string;
}

const MCP_SERVER_STATUS_VALUES = new Set<McpServerStatus["status"]>([
  "connected", "failed", "needs-auth", "pending", "disabled", "not_configured", "unknown",
]);

export function coerceMcpServerStatus(value: unknown): McpServerStatus["status"] {
  if (typeof value === "string" && MCP_SERVER_STATUS_VALUES.has(value as McpServerStatus["status"])) {
    return value as McpServerStatus["status"];
  }
  return "unknown";
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function normalizeMcpServerStatuses(value: unknown): McpServerStatus[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const server = entry as Record<string, unknown>;
    const name = optionalNonEmptyString(server.name);
    if (!name) return [];
    return [{
      name,
      status: coerceMcpServerStatus(server.status),
      ...(optionalNonEmptyString(server.error) ? { error: optionalNonEmptyString(server.error) } : {}),
      ...(optionalNonEmptyString(server.source) ? { source: optionalNonEmptyString(server.source) } : {}),
    }];
  });
}

export function mergeMcpServerStatuses(
  base: McpServerStatus[],
  updates: McpServerStatus[],
): McpServerStatus[] {
  const merged = new Map(base.map((server) => [server.name, server]));
  for (const server of updates) merged.set(server.name, server);
  return [...merged.values()];
}

export function applyMcpServerStatusChange(
  snapshot: McpStatusSnapshot | undefined,
  value: unknown,
): {
  snapshot: McpStatusSnapshot;
  name?: string;
  status: McpServerStatus["status"];
  previousStatus?: McpServerStatus["status"];
} {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const name = optionalNonEmptyString(data.serverName);
  const status = coerceMcpServerStatus(data.status);
  if (!name) {
    return {
      snapshot: snapshot ?? { servers: [], complete: false },
      status,
    };
  }

  const previous = snapshot?.servers.find((server) => server.name === name);
  const next: McpServerStatus = {
    name,
    status,
    ...(optionalNonEmptyString(data.error) ? { error: optionalNonEmptyString(data.error) } : {}),
    ...(optionalNonEmptyString(data.source) ? { source: optionalNonEmptyString(data.source) } : {}),
  };
  return {
    snapshot: {
      servers: mergeMcpServerStatuses(snapshot?.servers ?? [], [{
        ...previous,
        ...next,
        error: next.error,
      }]),
      complete: snapshot?.complete ?? false,
    },
    name,
    status,
    ...(previous ? { previousStatus: previous.status } : {}),
  };
}

export function getStaleMcpSessionServerName(
  toolName: string,
  result: string | undefined,
): string | undefined {
  if (!result) return undefined;
  const match = result.match(
    /MCP server ['"]([^'"]+)['"]:[\s\S]*MCP error\s+-32001:\s*Session not found\b/i,
  );
  const serverName = match?.[1]?.trim();
  if (!serverName) return undefined;
  const normalizedToolName = toolName.trim().toLocaleLowerCase();
  const normalizedServerName = serverName.toLocaleLowerCase();
  return normalizedToolName.startsWith(`${normalizedServerName}-`)
    ? serverName
    : undefined;
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
  clientMessageId?: string;
  /**
   * Shown in the transcript instead of `prompt`. Lets a caller add model-only framing
   * (for example hands-free voice context) without it appearing as something the user said.
   */
  displayPrompt?: string;
  /**
   * "system" marks an application-generated turn. The runtime records it with system
   * provenance, so it never appears in the transcript as a user message.
   */
  promptSource?: "system";
  /**
   * Reasoning effort for this turn, applied to the session just before the prompt is sent.
   * Lets one conversation think harder for some turns than others (Helm: typed vs spoken).
   */
  reasoningEffort?: string;
}

async function setSessionModeForSend(session: AgentSession, mode: string): Promise<void> {
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
  return session.invokeSlashCommand({ name: command.name, input: command.input });
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
  // `Pending response rejected since connection got disposed` is what every RPC
  // still in flight gets when a lost backend is force-stopped: the session is
  // no longer addressable, not merely slow.
  // The provider can also retain an input-item reference from the previous
  // session connection. It reports that as a 400 instead of a transport error,
  // but the cached SDK wrapper is stale and must take the same recovery path.
  return /\bSession not found\b/i.test(message)
    || /Pending response rejected since connection got disposed/i.test(message)
    || /input item ID does not belong to this connection/i.test(message);
}

export interface SessionResumeLease {
  sessionId: string;
  token: symbol;
}

export interface SessionRunnerDeps {
  /** Lazy accessor for the agent backend; the manager owns lifecycle. */
  getBackend(): AgentBackend | null;
  /** Human-readable reason the backend cannot take work right now (rotating, disconnected, not started). */
  getBackendUnavailableReason?(): string | undefined;
  /** Ask the backend whether its RPC channel still answers; false means disconnect recovery has been triggered. */
  probeBackendHealth?(reason: string): Promise<boolean>;
  /** Shared cache of CopilotSession objects (owned by SessionManager). */
  sessionObjects: Map<string, any>;
  /** Shared per-session MCP status cache (owned by SessionManager). */
  mcpStatus: Map<string, McpStatusSnapshot>;
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
  resumeSessionWithTimeout(
    backend: AgentBackend,
    sessionId: string,
    resume: Promise<any>,
    timeoutMessage: string,
  ): Promise<any>;
  notifySessionCapacityChanged(): void;
  findLinkedTask(sessionId: string): Task | undefined;
  lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null;
  persistAndRouteAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): RoutedSdkAttachment[] | undefined;
  cacheResumedSession(sessionId: string, session: any, sessionConfig?: any): Promise<any>;
  waitForSessionToolInitialization(sessionId: string, session: any): boolean | Promise<boolean>;
  abandonCachedSession(sessionId: string, expectedSession: any): Promise<void>;
  abortSession(sessionId: string): Promise<boolean>;
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
  /** Answers questions nobody has answered for an hour. Never rejects. */
  autoAnswerOverdueInteractions(sessionId: string): Promise<void>;
  recordPendingInteractionEvent(
    sessionId: string,
    kind: "user_input" | "elicitation",
    state: "requested" | "completed",
    at?: string,
  ): void;
  recordSessionAttention(sessionId: string, at?: string): void;
  touchSessionActivity?(sessionId: string, at: number): void;
  invalidateSessionListCache(reason?: string): void;
  /** Switches the live session to the effort a turn asked for. Best effort; never fails the turn. */
  applyTurnReasoningEffort?(sessionId: string, session: AgentSession, reasoningEffort: string): Promise<void>;
  maybeAutoNameSession(
    sessionId: string,
    options: SessionAutoNameOptions,
  ): void;
}

export class SessionRunner {
  private readonly watchdogPromises = new Map<string, Promise<void>>();
  private readonly sessionFeeds = new Map<string, SessionFeed>();
  private readonly mcpSessionRecoveryAttempts = new Map<string, {
    count: number;
    windowStartedAt: number;
  }>();

  constructor(private readonly deps: SessionRunnerDeps) {}

  async waitForWatchdogIdle(sessionId: string): Promise<void> {
    while (true) {
      const pending = this.watchdogPromises.get(sessionId);
      if (!pending) return;
      await pending;
    }
  }

  /** Subscribes once to a cached session's events; SessionManager calls this as it caches the session. */
  attachSession(sessionId: string, session: AgentSession): SessionFeed {
    const current = this.sessionFeeds.get(sessionId);
    if (current?.session === session) return current;
    current?.unsubscribe();
    const feed: SessionFeed = {
      session,
      unsubscribe: () => {},
      agentReportedAt: new Map(),
      readAgentCalls: new Map(),
      attentionMode: "normal",
    };
    this.sessionFeeds.set(sessionId, feed);
    feed.unsubscribe = session.on((event) => this.routeSessionEvent(sessionId, feed, event));
    return feed;
  }

  /** Ends the subscription as the session leaves the cache. */
  detachSession(sessionId: string, session: AgentSession): void {
    const feed = this.sessionFeeds.get(sessionId);
    if (feed?.session !== session) return;
    feed.unsubscribe();
    this.sessionFeeds.delete(sessionId);
  }

  private routeSessionEvent(sessionId: string, feed: SessionFeed, event: any): void {
    const mainAgent = !getSdkAgentId(event);
    const at = getEventTimestampMs(event) ?? Date.now();
    if (mainAgent) this.noteWhatMainAgentHeard(feed, event, at);
    if (feed.run && !feed.run.controller.isCompleted()) {
      feed.run.handleEvent(event);
      return;
    }
    if (feed.heldTurn) {
      feed.heldTurn.events.push(event);
      return;
    }
    if (!mainAgent || event?.type !== "assistant.turn_start") return;
    if (this.deps.sessionObjects.get(sessionId) !== feed.session) return;
    // A run still getting ready to send owns the turns that follow its prompt.
    if (this.deps.activeRunControllers.get(sessionId)?.isCompleted() === false) return;
    feed.heldTurn = { startedAt: at, events: [event] };
    this.followRuntimeTurn(sessionId);
  }

  private noteWhatMainAgentHeard(feed: SessionFeed, event: any, at: number): void {
    const data = event?.data;
    switch (event?.type) {
      case "system.notification": {
        const agentId = data?.kind?.agentId;
        if (typeof agentId === "string") feed.agentReportedAt.set(agentId, at);
        break;
      }
      case "tool.execution_start": {
        const agentId = data?.arguments?.agent_id;
        if (data?.toolName === "read_agent" && typeof agentId === "string" && typeof data?.toolCallId === "string") {
          feed.readAgentCalls.set(data.toolCallId, agentId);
        }
        break;
      }
      case "tool.execution_complete": {
        const agentId = feed.readAgentCalls.get(data?.toolCallId);
        if (agentId === undefined) break;
        feed.readAgentCalls.delete(data.toolCallId);
        // A read made before the agent finished is older than its finish, so it still counts as unheard.
        if (data?.success === true) feed.agentReportedAt.set(agentId, at);
        break;
      }
    }
  }

  /**
   * Opens a run for a turn the runtime started on its own, so it is shown and tracked like any other.
   * While the session is busy the turn stays held; whatever makes it busy calls this again when done
   * (a run letting go, a resume or an overlay operation ending), or the next run takes the turn.
   */
  followRuntimeTurn(sessionId: string): void {
    const feed = this.sessionFeeds.get(sessionId);
    const heldTurn = feed?.heldTurn;
    if (!feed || !heldTurn) return;
    // A claimed turn still held here belongs to a run that ended before it could register.
    if (heldTurn.claimed || this.deps.sessionObjects.get(sessionId) !== feed.session) {
      feed.heldTurn = undefined;
      return;
    }
    if (this.deps.activeRunControllers.has(sessionId) || this.deps.isSessionBusy(sessionId)) return;
    heldTurn.claimed = true;
    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    this.deps.sessionMetaStore?.clearTerminalOverlay(sessionId);
    bus.reset();
    const attentionMode = feed.attentionMode;
    this.startBackgroundRun(
      sessionId,
      bus,
      (runController) => this.runSessionOperation(sessionId, bus, runController, {
        resumeContext: "runtime_turn",
        idleSpanName: "session.runtimeTurnToIdle",
        startLog: `[sdk] [${sessionId.slice(0, 8)}] Following a turn the runtime started on its own...`,
        attentionMode,
        followsRuntimeTurn: true,
        execute: async () => {},
      }),
      { promptAccepted: false, attentionMode },
    ).markPromptAccepted();
  }

  private get client(): AgentBackend | null {
    return this.deps.getBackend();
  }

  private recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void {
    try {
      this.deps.telemetryStore?.recordSpan({ name, duration, sessionId, metadata, source: "server" });
    } catch { /* telemetry should never break core flow */ }
  }

  private clearMcpSessionRecoveryAttempts(sessionId: string, serverName: string): void {
    this.mcpSessionRecoveryAttempts.delete(`${sessionId}\0${serverName.toLocaleLowerCase()}`);
  }

  private scheduleStaleMcpSessionRecovery(sessionId: string, serverName: string): boolean {
    const key = `${sessionId}\0${serverName.toLocaleLowerCase()}`;
    const now = Date.now();
    const previous = this.mcpSessionRecoveryAttempts.get(key);
    const record = previous && now - previous.windowStartedAt < MCP_SESSION_RECOVERY_WINDOW_MS
      ? previous
      : { count: 0, windowStartedAt: now };
    if (record.count >= MCP_SESSION_RECOVERY_MAX_ATTEMPTS) {
      console.warn(
        `[sdk] [${sessionId.slice(0, 8)}] MCP ${serverName} stale-session recovery suppressed after ${record.count} attempts`,
      );
      this.recordSpan("session.mcp.staleSessionRecoverySuppressed", 0, sessionId, {
        serverName,
        attempts: record.count,
      });
      return false;
    }

    record.count += 1;
    this.mcpSessionRecoveryAttempts.set(key, record);
    this.deps.mcpStatus.delete(sessionId);
    this.deps.deferMcpStatusSessionEviction(sessionId, `mcp_session_not_found:${serverName}`);
    console.warn(
      `[sdk] [${sessionId.slice(0, 8)}] MCP ${serverName} lost its runtime session; refreshing the cached session after this run`,
    );
    this.recordSpan("session.mcp.staleSessionRecovery", 0, sessionId, {
      serverName,
      attempt: record.count,
    });
    return true;
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
    bus: SessionEventBus,
  ): SessionRunController {
    return this.deps.runStateController.createRunController(sessionId, bus);
  }

  private assertBackendAvailable(): void {
    const reason = this.deps.getBackendUnavailableReason?.();
    if (reason) throw new Error(reason);
    if (!this.client) throw new Error("SessionManager not initialized");
  }

  startWorkRun(
    sessionId: string,
    prompt: string,
    attachments?: StartWorkAttachment[],
    options: StartWorkOptions = {},
  ): SessionRunController {
    this.assertBackendAvailable();

    if (this.deps.isSessionBusy(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    this.deps.sessionMetaStore?.clearTerminalOverlay(sessionId);
    bus.reset();
    const hiddenPrompt = options.promptSource === "system";
    const visiblePrompt = options.displayPrompt ?? prompt;
    if (!hiddenPrompt) bus.setPendingPrompt(visiblePrompt, attachments, options.clientMessageId);
    return this.startBackgroundRun(
      sessionId,
      bus,
      (runController) => this.doWork(sessionId, prompt, bus, runController, attachments, options),
      {
        ...(hiddenPrompt ? {} : { pendingPrompt: visiblePrompt }),
        promptAccepted: false,
        attentionMode: options.attentionMode === "quiet" ? "quiet" : "normal",
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

  async steerSession(
    sessionId: string,
    prompt: string,
    attachments?: StartWorkAttachment[],
    clientMessageId?: string,
  ): Promise<void> {
    this.assertBackendAvailable();

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
    if (this.deps.runStateController.getRunRecords().get(sessionId)?.promptAccepted !== true) {
      throw new Error("Session is still starting the current turn; try again shortly");
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
        // This never reaches the SDK, so it will never appear in events.jsonl.
        bus.emit({ type: "assistant_partial", content: text, bridgeNative: true });
      }
      return;
    }

    const sdkAttachments = this.deps.persistAndRouteAttachments(sessionId, attachments);
    const attachCount = sdkAttachments?.length ?? 0;
    const t0 = Date.now();
    console.log(`[sdk] [${sid}] Steering prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`);

    bus.setPendingPrompt(prompt, attachments, clientMessageId);
    this.touchSessionRun(sessionId);
    try {
      if (
        runController.isCompleted()
        || this.deps.activeRunControllers.get(sessionId) !== runController
        || this.deps.sessionObjects.get(sessionId) !== session
      ) {
        throw new Error("Session ended before steering could attach; send a normal message instead");
      }
      await session.send({
        prompt,
        ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}),
        mode: "immediate",
      });
      if (runController.isCompleted()) {
        bus.discardPendingPrompt(prompt);
        throw new Error("Session ended before steering could attach; send a normal message instead");
      }
      this.touchSessionRun(sessionId);
      this.recordSpan("session.steer", Date.now() - t0, sessionId, {
        chars: prompt.length,
        attachments: attachCount,
      });
    } catch (error) {
      bus.discardPendingPrompt(prompt);
      throw error;
    }
  }

  private startBackgroundRun(
    sessionId: string,
    bus: SessionEventBus,
    runner: (runController: SessionRunController) => Promise<void>,
    metadata?: {
      pendingPrompt?: string;
      promptAccepted?: boolean;
      attentionMode?: "normal" | "quiet";
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
      if (this.deps.activeRunControllers.get(sessionId) === runController) {
        this.deps.activeRunControllers.delete(sessionId);
      }
      this.setSessionRunState(sessionId, "idle", {
      });
      // Before any pending eviction: a turn the runtime started while this run was letting go is next.
      this.followRuntimeTurn(sessionId);
      void this.deps.agentRegistry.reapFinishedSyncTasks(sessionId);
      this.deps.notifySessionCapacityChanged();
      this.deps.flushPendingSessionEviction(sessionId);
    });
    return runController;
  }

  async doWork(
    sessionId: string,
    prompt: string,
    bus: SessionEventBus,
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
    let displayPrompt: string | undefined = options.displayPrompt;
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
            bus.commitPendingPrompt();
            activeRunController.markPromptAccepted();
            activeRunController.completeDone(slashCommandResultToText(commandResult));
            return;
          }
          sendPrompt = commandResult.prompt;
          displayPrompt = commandResult.displayPrompt;
          mode = commandResult.mode ?? mode;
          bus.replacePendingPrompt(displayPrompt ?? sendPrompt);
          this.deps.runStateController.setSessionRunMetadata(sessionId, {
            pendingPrompt: displayPrompt ?? sendPrompt,
          });
        }
        if (options.reasoningEffort) {
          await this.deps.applyTurnReasoningEffort?.(sessionId, session, options.reasoningEffort);
        }
        await setSessionModeForSend(session, mode);
        await session.send({
          prompt: sendPrompt,
          ...(displayPrompt ? { displayPrompt } : {}),
          ...(options.promptSource ? { source: options.promptSource } : {}),
          ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}),
        });
      },
    });
  }

  private async runSessionOperation(
    sessionId: string,
    bus: SessionEventBus,
    runController: SessionRunController,
    opts: {
      resumeContext: string;
      idleSpanName: string;
      startLog: string;
      execute?: (session: any) => Promise<void>;
      attentionMode?: SessionAttentionMode;
      completionAttention?: boolean | CompletionAttentionOptions;
      historyTruncation?: QuietIntervalDeferTailTruncationRequest;
      /** The run follows a turn the runtime already started: there is no prompt to prepare or send. */
      followsRuntimeTurn?: boolean;
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
    const configuredMcpServersByToolPrefix = [...Object.keys(resumeConfig.mcpServers ?? {})]
      .filter((name) => name.trim())
      .sort((a, b) => b.length - a.length);
    const isConfiguredMcpServer = (name: unknown): name is string =>
      typeof name === "string"
      && configuredMcpServerNames.has(name.trim().toLocaleLowerCase());
    const getConfiguredMcpServerForTool = (toolName: string): string | undefined => {
      const normalizedToolName = toolName.trim().toLocaleLowerCase();
      return configuredMcpServersByToolPrefix.find((name) =>
        normalizedToolName.startsWith(`${name.toLocaleLowerCase()}-`)
      );
    };

    if (linkedTask) {
      console.log(`[sdk] [${sid}] Injecting task context for "${linkedTask.title}"`);
    }

    let usedCache = false;
    const resumeSession = async (): Promise<any> => {
      const resumeStart = Date.now();
      let s = this.deps.sessionObjects.get(sessionId);
      if (!s) {
        s = await this.deps.awaitPendingSessionCreation(sessionId)
          ?? this.deps.sessionObjects.get(sessionId);
        if (s) {
          console.log(`[sdk] [${sid}] Session creation completed`);
        }
      }
      if (s) {
        usedCache = true;
        console.log(`[sdk] [${sid}] Reusing cached session object`);
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
          s = await this.deps.resumeSessionWithTimeout(
            this.client!,
            sessionId,
            this.client!.resumeSession(sessionId, resumeConfig),
            "resumeSession timed out after 60s",
          );
          s = await this.deps.cacheResumedSession(sessionId, s, resumeConfig);
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
    /** A turn the runtime starts after this run is followed with this run's attention mode. */
    const rememberAttentionMode = (activeSession: unknown): boolean => {
      const feed = this.sessionFeeds.get(sessionId);
      if (!feed || feed.session !== activeSession) return false;
      feed.attentionMode = opts.attentionMode ?? "normal";
      return true;
    };
    if (!rememberAttentionMode(session) && opts.followsRuntimeTurn) return;

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
        console.warn(`[sdk] [${sid}] ${stepName} still pending after run completion — retaining the single session owner`);
        return { completed: true };
      }
      if (result.type === "error") throw result.error;
      return { completed: false, value: result.value };
    };

    const toolNameMap = new Map<string, string>();
    const toolArgsMap = new Map<string, unknown>();
    const toolStartTimes = new Map<string, number>();
    const toolLoopGuard = createToolLoopGuard();
    const correlator = new SubagentCorrelator();
    const subAgentToolCallIds = new Set<string>();
    const activeSubAgentToolCallIds = new Set<string>();
    const subAgentTerminalToolCallIds = new Set<string>();
    const subAgentTurnIdMap = new Map<string, string>();
    const activeExternalTools = new Map<string, ActiveExternalToolCall>();
    const staleMcpServersScheduledThisRun = new Set<string>();
    const contextTelemetryProvider = this.client?.id ?? "copilot";
    const contextTelemetryProviderSessionId = sessionId;
    let currentBridgeTurnId: string | undefined;
    let pendingTerminalCompletion: TerminalCompletion | undefined;
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
        return correlator.resolve(toolCallId).displayName
          ?? toolNameMap.get(toolCallId)
          ?? fallbackName
          ?? "unknown";
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
    };
    const clearExternalToolRequest = (requestId: unknown, eventAt: number) => {
      if (typeof requestId !== "string" || !requestId) return;
      const active = activeExternalTools.get(requestId);
      if (active) active.lastActivityAt = eventAt;
      activeExternalTools.delete(requestId);
    };
    const clearExternalToolsForToolCall = (toolCallId: unknown, eventAt: number) => {
      if (typeof toolCallId !== "string" || !toolCallId) return;
      for (const [requestId, active] of activeExternalTools) {
        if (active.toolCallId === toolCallId) {
          active.lastActivityAt = eventAt;
          activeExternalTools.delete(requestId);
        }
      }
    };
    let lastAssistantContent: string | undefined;
    let lastAssistantSourceEventId: string | undefined;
    let lastEventTime = Date.now();
    let sendStart = lastEventTime;
    let promptDelivered = false;
    let lastLogStat: { mtimeMs: number; size: number } | undefined;
    let lastLogGrowthAt = 0;
    let lastRuntimeAnswer: RuntimeAnswer | undefined;
    let lastLiveEventType: string | undefined;
    let lastLiveEventAt: number | undefined;
    let lastLiveEventOrigin: SessionEventOrigin | undefined;
    // Main-agent turns only. Sub-agents share the event stream, and their turns say nothing about the run.
    let liveTurnStartCount = 0;
    let liveTurnEndCount = 0;
    let lastLiveTurnEndAt: number | undefined;
    let liveAssistantTurnOpen = false;
    let staleCacheRetryCount = 0;
    let acceptingSessionEvents = false;
    let sendOperationInFlight = false;
    let pendingStaleSessionError: unknown;
    let staleCacheRecoveryPromise: Promise<void> | undefined;
    let retryStaleCachedSession: ((reason: unknown, source: "event" | "send") => Promise<void>) | undefined;
    let turnHadSideEffects = false;
    const resetRunTelemetryState = () => {
      promptDelivered = false;
      lastLogStat = undefined;
      lastLogGrowthAt = 0;
      lastRuntimeAnswer = undefined;
      lastLiveEventType = undefined;
      lastLiveEventAt = undefined;
      lastLiveEventOrigin = undefined;
      liveTurnStartCount = 0;
      liveTurnEndCount = 0;
      lastLiveTurnEndAt = undefined;
      liveAssistantTurnOpen = false;
      turnHadSideEffects = false;
    };
    const runSendStep = async <T>(
      stepName: string,
      step: () => Promise<T>,
    ): Promise<{ completed: true } | { completed: false; value: T }> => {
      sendOperationInFlight = true;
      try {
        const result = await runStepOrCompletion(stepName, step);
        if (!result.completed) promptDelivered = true;
        return result;
      } finally {
        sendOperationInFlight = false;
      }
    };
    const beginSend = () => {
      sendStart = Date.now();
      lastEventTime = sendStart;
      lastAssistantContent = undefined;
      lastAssistantSourceEventId = undefined;
      pendingTerminalCompletion = undefined;
      activeExternalTools.clear();
      resetRunTelemetryState();
      acceptingSessionEvents = true;
    };

    const getEventTimestampIso = (event: any): string | undefined => {
      const eventTime = getEventTimestampMs(event);
      return eventTime === undefined ? undefined : new Date(eventTime).toISOString();
    };
    const publishContextSummary = (summary: ReturnType<SessionContextStore["getSummary"]>): void => {
      if (summary) bus.emit({ type: "context_update", summary });
    };
    const getSubagentContextTurnId = (event: any): string | undefined => {
      const data = event?.data;
      const agentId = getSdkAgentId(event);
      const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
      const parentToolCallId = typeof data?.parentToolCallId === "string" ? data.parentToolCallId : undefined;
      return (agentId ? subAgentTurnIdMap.get(agentId) : undefined)
        ?? (toolCallId ? subAgentTurnIdMap.get(toolCallId) : undefined)
        ?? (parentToolCallId ? subAgentTurnIdMap.get(parentToolCallId) : undefined);
    };
    const recordLiveContextTelemetry = (event: any, live: boolean): void => {
      const store = this.deps.sessionContextStore;
      const data = event?.data;
      const subagentTurnId = getSubagentContextTurnId(event);
      const isSubagent = Boolean(subagentTurnId || getSdkAgentId(event) || data?.parentToolCallId
        || data?.isSubAgent === true || data?.subagent === true || data?.initiator === "sub-agent"
        || data?.interactionType === "conversation-subagent"
        || (event?.type === "prompt_cache_break" && typeof data?.agentName === "string"));
      const bridgeTurnId = isSubagent ? subagentTurnId : currentBridgeTurnId;
      const attribution = isSubagent
        ? "subagent_turn"
        : bridgeTurnId
          ? "turn"
          : "session_overhead";
      const cacheBreak = live ? normalizePromptCacheBreak(event) : undefined;
      if (cacheBreak) {
        this.recordSpan("session.prompt_cache_break", 0, sessionId, {
          ...cacheBreak,
          ...promptProcessMetadata,
          attribution,
          ...(bridgeTurnId ? { bridgeTurnId } : {}),
        });
      }
      if (!store) return;
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
    const getActiveToolTelemetry = (): Record<string, unknown> => {
      if (toolStartTimes.size === 0) return {};
      return {
        activeToolCount: toolStartTimes.size,
        activeToolNames: [...new Set(
          [...toolStartTimes.keys()].map((toolCallId) => toolNameMap.get(toolCallId) ?? "unknown"),
        )],
      };
    };
    const getLogProgressAt = () => Math.max(
      lastLogGrowthAt,
      lastLogStat !== undefined && lastLogStat.mtimeMs >= sendStart
        ? Math.min(lastLogStat.mtimeMs, Date.now())
        : 0,
    );
    const getLastProgressAt = () => Math.max(lastEventTime, getLogProgressAt());
    const buildRunTelemetryMetadata = (now = Date.now()): Record<string, unknown> => ({
      runStartedAt: new Date(sendStart).toISOString(),
      elapsedMs: Math.max(0, now - sendStart),
      lastLiveEventType,
      lastLiveEventAgeMs: getAgeMs(now, lastLiveEventAt),
      lastLiveEventOrigin,
      lastEventTimeAgeMs: getAgeMs(now, lastEventTime),
      lastLogMtimeAgeMs: getAgeMs(now, lastLogStat?.mtimeMs),
      lastLogGrowthAgeMs: getAgeMs(now, lastLogGrowthAt || undefined),
      lastProgressAgeMs: getAgeMs(now, getLastProgressAt()),
      lastRuntimeAnswer,
      liveTurnStartCount,
      liveTurnEndCount,
      lastLiveTurnEndAgeMs: getAgeMs(now, lastLiveTurnEndAt),
      pendingUserInputCount: this.deps.getPendingUserInputCount(sessionId),
      pendingInteractionCount: this.deps.getPendingInteractionCount(sessionId),
      staleCacheRetryCount: staleCacheRetryCount || undefined,
      ...getActiveToolTelemetry(),
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
    const getTerminalCompletionSource = (eventType: string, origin: SessionEventOrigin): string => {
      const normalizedEventType = eventType.replace(/\./g, "_");
      if (origin === "persisted_recovery") return `persisted_${normalizedEventType}_recovery`;
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
    const completeSessionError = (event: any, context: SessionEventHandlingContext) => {
      if (runController.isCompleted()) return;
      const data = event?.data;
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
    };
    const isLiveRunTerminalEvent = (event: any): boolean =>
      LIVE_RUN_TERMINAL_EVENT_TYPES.has(event?.type) && !isSdkSubagentSessionError(event);
    const noteLiveEvent = (event: any, eventAt: number, origin: SessionEventOrigin) => {
      const eventType = typeof event?.type === "string" ? event.type : undefined;
      if (!eventType) return;
      lastLiveEventType = eventType;
      lastLiveEventAt = eventAt;
      lastLiveEventOrigin = origin;
      if (getSdkAgentId(event)) return;
      if (eventType === "assistant.turn_start") {
        liveAssistantTurnOpen = true;
        liveTurnStartCount += 1;
      }
      if (eventType === "assistant.turn_end") {
        liveAssistantTurnOpen = false;
        liveTurnEndCount += 1;
        lastLiveTurnEndAt = eventAt;
      }
    };

    /**
     * Ends a run whose live ending never arrived, using what the log says about how it ended. The
     * caller has already established that it ended: the runtime said so, or the ending is conclusive.
     */
    const finishRunFromLog = (ending: PersistedRunEnding, runtimeAnswer: RuntimeAnswer) => {
      if (runController.isCompleted()) return;
      const context: SessionEventHandlingContext = {
        origin: "persisted_recovery",
        recoveryReason: `runtime ${runtimeAnswer}`,
      };
      lastAssistantContent = ending.assistantContent ?? lastAssistantContent;
      lastAssistantSourceEventId = ending.assistantSourceEventId ?? lastAssistantSourceEventId;
      console.warn(
        `[sdk] [${sid}] ✅ Run ended without a live signal (runtime ${runtimeAnswer}, log says ${ending.event?.type ?? "nothing"}) — finishing from the log`,
      );
      recordRunSpan("session.run.recovery", 0, {
        outcome: "finished_from_log",
        runtimeAnswer,
        endingEventType: ending.event?.type,
        endingConclusive: ending.conclusive,
      });
      if (ending.conclusive) {
        // An error, abort or shutdown is handled exactly as it would have been live.
        handleEvent(ending.event, context);
        return;
      }
      const content = pendingTerminalCompletion?.content ?? lastAssistantContent ?? "(no response)";
      endCurrentContextTurn(ending.event);
      recordRunCompletion(ending.event, context, "done", {
        finalContentLength: content.length,
        assistantContentKnown: lastAssistantContent !== undefined,
      });
      recordCompletionAttention("done", ending.event);
      runController.completeDone(content, {
        ...(pendingTerminalCompletion ? { terminalCompletion: pendingTerminalCompletion } : {}),
        ...(getSdkEventId(ending.event) ? { sourceEventId: getSdkEventId(ending.event) } : {}),
        ...(lastAssistantSourceEventId ? { assistantSourceEventId: lastAssistantSourceEventId } : {}),
      });
      pendingTerminalCompletion = undefined;
    };

    const handleEvent = (event: any, context: SessionEventHandlingContext) => {
      if (!acceptingSessionEvents || runController.isCompleted()) return;
      const eventAt = Date.now();
      if (context.origin === "live") {
        noteLiveEvent(event, eventAt, context.origin);
      }
      const isTerminalEvent = isLiveRunTerminalEvent(event);
      if (!isTerminalEvent) {
        lastEventTime = eventAt;
        this.touchSessionRun(sessionId, eventAt);
      }
      const data = (event as any).data;
      recordLiveContextTelemetry(event, context.origin === "live");
      if (opts.attentionMode !== "quiet") {
        this.persistLastVisibleActivityAt(sessionId, getVisibleEventTimestamp(event, sessionId));
      }
      switch (event.type) {
        case "user_input.requested": {
          turnHadSideEffects = true;
          try {
            const request = normalizePendingUserInputRequest(data, getEventTimestampIso(event));
            bus.emitUserInputRequested(request, getEventTimestampIso(event));
            this.deps.recordPendingInteractionEvent(
              sessionId,
              "user_input",
              "requested",
              getEventTimestampIso(event),
            );
          } catch (error) {
            console.warn(`[sdk] [${sid}] Ignoring invalid user input request event:`, error);
          }
          break;
        }
        case "user_input.completed": {
          const requestId = typeof data?.requestId === "string" ? data.requestId : undefined;
          if (!requestId) {
            console.warn(`[sdk] [${sid}] Ignoring user input completion without requestId`);
            break;
          }
          if (
            data.dismissed !== true
            && typeof data.answer === "string"
            && typeof data.wasFreeform === "boolean"
          ) {
            bus.emitUserInputAnswered(requestId, {
              answer: data.answer,
              wasFreeform: data.wasFreeform,
            }, getEventTimestampIso(event));
          } else {
            bus.emitUserInputCanceled(requestId, {
              reason: "session_ended",
              timestamp: getEventTimestampIso(event),
            });
          }
          this.deps.recordPendingInteractionEvent(
            sessionId,
            "user_input",
            "completed",
            getEventTimestampIso(event),
          );
          break;
        }
        case "elicitation.requested": {
          turnHadSideEffects = true;
          try {
            const request = normalizePendingElicitationRequest(data, getEventTimestampIso(event));
            bus.emitElicitationRequested(request, getEventTimestampIso(event));
            this.deps.recordPendingInteractionEvent(
              sessionId,
              "elicitation",
              "requested",
              getEventTimestampIso(event),
            );
          } catch (error) {
            console.warn(`[sdk] [${sid}] Ignoring invalid elicitation request event:`, error);
          }
          break;
        }
        case "elicitation.completed": {
          const requestId = typeof data?.requestId === "string" ? data.requestId : undefined;
          if (!requestId) {
            console.warn(`[sdk] [${sid}] Ignoring elicitation completion without requestId`);
            break;
          }
          const action = data.action;
          if (action === "cancel") {
            bus.emitElicitationCanceled(requestId, {
              reason: "session_ended",
              timestamp: getEventTimestampIso(event),
            });
          } else if (action === "accept" || action === "decline") {
            bus.emitElicitationResolved(requestId, action, getEventTimestampIso(event));
          } else {
            console.warn(`[sdk] [${sid}] Ignoring elicitation completion with invalid action`);
            break;
          }
          this.deps.recordPendingInteractionEvent(
            sessionId,
            "elicitation",
            "completed",
            getEventTimestampIso(event),
          );
          break;
        }
        case "user.message": {
          if (isSdkAgentUserMessage(event)) {
            const agentId = getSdkAgentId(event);
            const content = typeof data?.content === "string"
              ? data.content
              : typeof data?.prompt === "string"
                ? data.prompt
                : undefined;
            if (content) {
              const toolCallId = agentId
                ? correlator.resolveAgentToolCallId(agentId)
                : activeSubAgentToolCallIds.size === 1
                  ? [...activeSubAgentToolCallIds][0]
                  : undefined;
              if (agentId) {
                correlator.recordInstruction(agentId, content);
              } else if (toolCallId) {
                correlator.recordInstructionForToolCall(toolCallId, content);
              }
              if (toolCallId) {
                const resolution = correlator.resolve(toolCallId);
                bus.emit({
                  type: "tool_update",
                  toolCallId,
                  name: resolution.displayName ?? getTrackedToolDisplayName(toolCallId),
                  args: toolArgsMap.get(toolCallId),
                  isSubAgent: true,
                  agentInstructions: buildSubagentInstructions(
                    toolArgsMap.get(toolCallId),
                    resolution.instructions,
                  ),
                  ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
                });
              }
            }
            break;
          }
          bus.commitPendingPrompt(
            typeof data?.content === "string"
              ? data.content
              : typeof data?.prompt === "string"
                ? data.prompt
                : undefined,
            getSdkEventId(event),
            getEventTimestampIso(event),
          );
          runController.markPromptAccepted();
          if (typeof data?.content === "string" && !("source" in (data ?? {}))) {
            this.deps.maybeAutoNameSession(sessionId, { session, userMessages: [data.content] });
          }
          break;
        }
        case "assistant.turn_start":
          if (activeSubAgentToolCallIds.size > 0) {
            console.log(`[sdk] [${sid}] ⏳ Sub-agent turn started`);
            break;
          }
          console.log(`[sdk] [${sid}] ⏳ Turn started`);
          currentBridgeTurnId = getSdkTurnId(event) ?? `turn-${randomUUID()}`;
          const turnInstanceId = getAssistantTurnInstanceId(
            event,
            `turn-instance-${randomUUID()}`,
          );
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
            turnInstanceId,
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          });
          break;
        case "assistant.message_delta":
          if (data?.parentToolCallId) break;
          if (data?.deltaContent) {
            turnHadSideEffects = true;
            bus.emit({
              type: "delta",
              content: data.deltaContent,
              ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
            });
          }
          break;
        case "assistant.reasoning_delta":
          // Sub-agent thinking belongs to the sub-agent, not to the main transcript.
          if (getSdkAgentId(event) || data?.parentToolCallId) break;
          if (typeof data?.deltaContent === "string" && data.deltaContent) {
            bus.emit({
              type: "reasoning_delta",
              content: data.deltaContent,
              ...(typeof data?.reasoningId === "string" ? { reasoningId: data.reasoningId } : {}),
              timestamp: event.timestamp,
            });
          }
          break;
        case "assistant.reasoning":
          // The complete block, sent after its deltas. It repairs a block whose deltas were missed
          // (a reconnect, or a model that does not stream its thinking).
          if (getSdkAgentId(event) || data?.parentToolCallId) break;
          if (typeof data?.content === "string" && data.content.trim()) {
            bus.emit({
              type: "reasoning",
              content: data.content,
              ...(typeof data?.reasoningId === "string" ? { reasoningId: data.reasoningId } : {}),
              timestamp: event.timestamp,
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
          if (data?.content || data?.toolRequests?.length) {
            turnHadSideEffects = true;
          }
          if (data?.parentToolCallId && data?.content) {
            correlator.recordResponse(data.parentToolCallId, data.content);
            const resolution = correlator.resolve(data.parentToolCallId);
            bus.emit({
              type: "tool_update",
              toolCallId: data.parentToolCallId,
              name: resolution.displayName ?? getTrackedToolDisplayName(data.parentToolCallId),
              args: toolArgsMap.get(data.parentToolCallId),
              isSubAgent: true,
              result: data.content,
              completedAt: getEventTimestampIso(event),
              agentInstructions: buildSubagentInstructions(
                toolArgsMap.get(data.parentToolCallId),
                resolution.instructions,
              ),
              ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
            });
            break;
          }
          if (data?.content) {
            console.log(`[sdk] [${sid}] ✅ Response (${data.content.length} chars)`);
            lastAssistantContent = data.content;
            lastAssistantSourceEventId = getSdkEventId(event);
          }
          // `reasoningText` is the only copy of the thinking that reaches events.jsonl, so this is
          // the moment the live block gains the identity its disk entry will be committed under.
          if (
            !getSdkAgentId(event)
            && !data?.parentToolCallId
            && typeof data?.reasoningText === "string"
            && data.reasoningText.trim()
          ) {
            bus.emit({
              type: "reasoning_committed",
              content: data.reasoningText,
              timestamp: event.timestamp,
              ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
            });
          }
          if (data?.content || data?.toolRequests?.length) {
            bus.emit({
              type: "assistant_partial",
              content: data.content ?? "",
              timestamp: event.timestamp,
              ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
            });
          }
          break;
        case "external_tool.requested": {
          turnHadSideEffects = true;
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
          turnHadSideEffects = true;
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
            toolArgsMap.set(data.toolCallId, data?.arguments);
            toolStartTimes.set(data.toolCallId, Date.now());
            pendingTerminalCompletion = extractTerminalCompletionFromToolCall(
              toolName,
              data?.arguments,
            ) ?? pendingTerminalCompletion;
          }
          const pendingAgent = data?.toolCallId ? correlator.resolve(data.toolCallId) : undefined;
          const displayName = pendingAgent?.displayName ?? toolName;
          console.log(`[sdk] [${sid}] 🔧 Tool: ${displayName}${data?.parentToolCallId ? ` (sub-agent)` : ""}`);
          bus.emit({
            type: "tool_start",
            toolCallId: data?.toolCallId,
            name: displayName,
            args: data?.arguments,
            parentToolCallId: data?.parentToolCallId,
            isSubAgent: pendingAgent?.isSubAgent ? true : undefined,
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
          clearExternalToolsForToolCall(data?.toolCallId, eventAt);
          const completedToolName = toolNameMap.get(data?.toolCallId) ?? "unknown";
          const completedToolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
          const completedSubAgent = completedToolCallId
            ? subAgentToolCallIds.delete(completedToolCallId)
            : false;
          if (completedToolCallId) correlator.completeTool(completedToolCallId);
          const resolution = completedToolCallId
            ? correlator.resolve(completedToolCallId)
            : { isSubAgent: false };
          const outcome = resolveToolOutcome(
            resolution,
            { success: data?.success, data },
            completedToolName,
          );
          const ok = outcome.success !== false;
          const failure = ok ? undefined : classifyToolFailure(outcome.result);
          console.log(`[sdk] [${sid}] 🔧 Tool complete: ${outcome.displayName} (${ok ? "ok" : `failed:${failure!.category}`})`);
          if (failure) {
            this.recordSpan("tool.failure", 0, sessionId, {
              toolName: completedToolName,
              category: failure.category,
              retryable: failure.retryable,
            });
            console.warn(`[sdk] [${sid}] Tool failure guidance: ${failure.guidance}`);
          }
          const configuredMcpServer = getConfiguredMcpServerForTool(completedToolName);
          const configuredMcpServerKey = configuredMcpServer?.toLocaleLowerCase();
          if (
            ok
            && configuredMcpServer
            && configuredMcpServerKey
            && !staleMcpServersScheduledThisRun.has(configuredMcpServerKey)
          ) {
            this.clearMcpSessionRecoveryAttempts(sessionId, configuredMcpServer);
          } else if (!ok && failure?.category === "transport") {
            const staleMcpServer = getStaleMcpSessionServerName(completedToolName, outcome.result);
            const staleMcpServerKey = staleMcpServer?.toLocaleLowerCase();
            if (
              staleMcpServer
              && staleMcpServerKey
              && isConfiguredMcpServer(staleMcpServer)
              && !staleMcpServersScheduledThisRun.has(staleMcpServerKey)
            ) {
              if (this.scheduleStaleMcpSessionRecovery(sessionId, staleMcpServer)) {
                staleMcpServersScheduledThisRun.add(staleMcpServerKey);
              }
            }
          }
          const toolStart = toolStartTimes.get(data?.toolCallId);
          if (toolStart) {
            this.recordSpan("tool.execution", Date.now() - toolStart, sessionId, {
              toolName: completedToolName,
              success: ok,
              isSubAgent: outcome.isSubAgent || undefined,
            });
          }
          if (data?.toolCallId) toolStartTimes.delete(data.toolCallId);
          bus.emit({
            type: "tool_done",
            toolCallId: data?.toolCallId,
            name: outcome.displayName,
            result: outcome.result,
            success: outcome.success,
            isSubAgent: outcome.isSubAgent || undefined,
            agentInstructions: outcome.isSubAgent
              ? buildSubagentInstructions(
                  completedToolCallId ? toolArgsMap.get(completedToolCallId) : undefined,
                  resolution.instructions,
                )
              : undefined,
            timestamp: event.timestamp,
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          });
          if (
            typeof data?.toolCallId === "string"
            && completedSubAgent
          ) {
            void this.deps.agentRegistry.reapFinishedSyncTasks(sessionId, data.toolCallId);
          }
          if (
            completedToolCallId
            && (!completedSubAgent || subAgentTerminalToolCallIds.delete(completedToolCallId))
          ) {
            correlator.forget(completedToolCallId);
            if (completedToolName !== "task" || completedSubAgent) {
              toolArgsMap.delete(completedToolCallId);
            }
          }
          break;
        }
        case "subagent.started": {
          turnHadSideEffects = true;
          const displayName = formatSubagentDisplayName(data);
          console.log(`[sdk] [${sid}] ${displayName}`);
          if (data?.toolCallId) {
            const agentId = getSdkAgentId(event);
            correlator.startSubagent(data.toolCallId, agentId, data);
            subAgentToolCallIds.add(data.toolCallId);
            activeSubAgentToolCallIds.add(data.toolCallId);
            const subagentBridgeTurnId = `subagent-${randomUUID()}`;
            subAgentTurnIdMap.set(data.toolCallId, subagentBridgeTurnId);
            if (agentId) subAgentTurnIdMap.set(agentId, subagentBridgeTurnId);
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
            args: toolArgsMap.get(data?.toolCallId),
            isSubAgent: true,
            agentInstructions: buildSubagentInstructions(
              toolArgsMap.get(data?.toolCallId),
              data?.toolCallId ? correlator.resolve(data.toolCallId).instructions : undefined,
            ),
            ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
          });
          this.refreshSessionAgents(sessionId, "subagent.started");
          break;
        }
        case "subagent.completed":
        case "subagent.failed": {
          const subagentToolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
          // `data.toolCallId` is authoritative here. A background agent's launch has already been
          // sealed as successful by this point, so the correlator ignores this for that case.
          if (event.type === "subagent.failed" && subagentToolCallId) {
            correlator.recordSubagentFailure(subagentToolCallId, data?.error);
          }
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
            activeSubAgentToolCallIds.delete(subagentToolCallId);
            const resolution = correlator.resolve(subagentToolCallId);
            // The runtime reports an agent's end more than once. By the repeat, its launching call
            // has completed and the correlation is gone, so there is nothing left to add, and the
            // only name still on hand is the raw tool's: sending it would relabel the finished
            // agent row as "task".
            if (resolution.isSubAgent) {
              bus.emit({
                type: "tool_update",
                toolCallId: subagentToolCallId,
                name: resolution.displayName ?? getTrackedToolDisplayName(subagentToolCallId),
                args: toolArgsMap.get(subagentToolCallId),
                isSubAgent: true,
                result: resolution.response,
                agentInstructions: buildSubagentInstructions(
                  toolArgsMap.get(subagentToolCallId),
                  resolution.instructions,
                ),
                completedAt: getEventTimestampIso(event),
                ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
              });
            }
            subAgentTurnIdMap.delete(subagentToolCallId);
            const agentId = getSdkAgentId(event);
            if (agentId) subAgentTurnIdMap.delete(agentId);
            if (!toolStartTimes.has(subagentToolCallId)) {
              correlator.forget(subagentToolCallId);
              toolArgsMap.delete(subagentToolCallId);
            } else {
              subAgentTerminalToolCallIds.add(subagentToolCallId);
            }
          }
          this.refreshSessionAgents(sessionId, event.type);
          break;
        }
        case "session.background_tasks_changed":
          this.refreshSessionAgents(sessionId, "background_tasks_changed");
          break;
        case "system.notification": {
          const kind = (data?.kind ?? {}) as { type?: string };
          if (typeof kind.type === "string" && kind.type.startsWith("agent_")) {
            this.refreshSessionAgents(sessionId, `notification:${kind.type}`);
          }
          break;
        }
        case "assistant.turn_end": {
          turnHadSideEffects = true;
          endCurrentContextTurn(event);
          break;
        }
        case "assistant.idle":
          // The main agent stopped. `session.idle` follows at once unless a background agent or an
          // attached shell defers it, so ask the runtime now instead of waiting for the next tick.
          if (!getSdkAgentId(event)) startWatchdogTick();
          break;
        case "session.error": {
          const agentId = getSdkAgentId(event);
          if (agentId) {
            correlator.recordAgentError(agentId, data?.message);
            console.warn(
              `[sdk] [${sid}] Subagent ${agentId} error did not terminate the parent run: ${data?.message ?? "unknown"}`,
            );
            recordRunSpan("session.subagent.error", 0, {
              subagentTracked: correlator.isTrackedAgent(agentId),
              errorType: typeof data?.errorType === "string" ? data.errorType : undefined,
              errorMessagePresent: typeof data?.message === "string",
              errorMessageLength: typeof data?.message === "string" ? data.message.length : undefined,
            }, eventAt);
            break;
          }
          if (
            usedCache
            && !opts.followsRuntimeTurn
            && isStaleAgentSessionError(data?.message)
            && !turnHadSideEffects
            && !runController.isCompleted()
          ) {
            // Some provider failures arrive as a terminal SDK event after
            // session.send has already accepted the prompt, so the RPC catch
            // path cannot see them. Hold the run open and refresh the cached
            // wrapper before allowing the error to reach the user.
            acceptingSessionEvents = false;
            pendingStaleSessionError ??= data?.message;
            if (!sendOperationInFlight && retryStaleCachedSession) {
              const reason = pendingStaleSessionError;
              pendingStaleSessionError = undefined;
              void retryStaleCachedSession(reason, "event").catch((error) => {
                if (runController.isCompleted()) return;
                const message = getErrorMessage(error);
                console.error(`[sdk] [${sid}] Stale cached session recovery failed: ${message}`);
                runController.completeError(message);
              });
            }
            break;
          }
          completeSessionError(event, context);
          break;
        }
        case "abort": {
          const reason = data?.reason ?? "user initiated";
          console.log(`[sdk] [${sid}] 🛑 Aborted: ${reason}`);
          endCurrentContextTurn(event);
          const partialContent = lastAssistantContent ?? bus.getStreamingContent();
          recordRunCompletion(event, context, "aborted", {
            partialContentLength: partialContent.length,
            abortReasonPresent: typeof data?.reason === "string",
          });
          runController.completeAborted(partialContent, {
            sourceEventId: getSdkEventId(event),
            ...(lastAssistantSourceEventId ? { assistantSourceEventId: lastAssistantSourceEventId } : {}),
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
            const partialContent = lastAssistantContent ?? bus.getStreamingContent();
            recordRunCompletion(event, context, "shutdown", {
              shutdownType,
              partialContentLength: partialContent.length,
            });
            runController.completeShutdown(partialContent, {
              sourceEventId: getSdkEventId(event),
              ...(lastAssistantSourceEventId ? { assistantSourceEventId: lastAssistantSourceEventId } : {}),
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
          if (staleMcpServersScheduledThisRun.size > 0) {
            this.deps.mcpStatus.delete(sessionId);
          }
          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          const terminalCompletion = extractTerminalCompletion(event);
          const resolvedTerminalCompletion = terminalCompletion ?? pendingTerminalCompletion;
          const content = resolvedTerminalCompletion?.content ?? lastAssistantContent ?? "(no response)";
          if (
            context.origin === "live"
            && liveAssistantTurnOpen
            && lastLiveTurnEndAt !== undefined
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
              ...(lastAssistantSourceEventId ? { assistantSourceEventId: lastAssistantSourceEventId } : {}),
            },
          );
          pendingTerminalCompletion = undefined;
          break;
        }
        case "session.mcp_servers_loaded": {
          if (!Array.isArray(data?.servers)) break;
          const servers = normalizeMcpServerStatuses(data.servers);
          const observedAt = context.origin === "live" ? eventAt : (Date.parse(event.timestamp) || 0);
          const current = this.deps.mcpStatus.get(sessionId);
          if (current?.observedAt !== undefined && current.observedAt > observedAt) break;
          const snapshot = stampMcpStatusSnapshot({ servers, complete: true }, sessionId,
            context.origin === "live" ? "live-event" : "replay-event", observedAt);
          this.deps.mcpStatus.set(sessionId, snapshot);
          const failed = servers.filter((s) => s.status === "failed");
          if (failed.length > 0) {
            console.warn(`[sdk] [${sid}] ⚠️ MCP failures: ${failed.map((s) => `${s.name} (${s.error ?? "unknown"})`).join(", ")}`);
          }
          console.log(`[sdk] [${sid}] 🔌 MCP: ${servers.map((s) => `${s.name}=${s.status}`).join(", ")}`);
          bus.emit({ type: "mcp_status", servers: snapshot.servers });
          break;
        }
        case "session.mcp_server_status_changed": {
          const observedAt = context.origin === "live" ? eventAt : (Date.parse(event.timestamp) || 0);
          const current = this.deps.mcpStatus.get(sessionId);
          if (current?.observedAt !== undefined && current.observedAt > observedAt) break;
          const update = applyMcpServerStatusChange(current, data);
          const { name, status, previousStatus } = update;
          if (!name) break;
          update.snapshot = stampMcpStatusSnapshot(update.snapshot, sessionId,
            context.origin === "live" ? "live-event" : "replay-event", observedAt, name);
          this.deps.mcpStatus.set(sessionId, update.snapshot);
          if (
            context.origin === "live"
            && previousStatus === "connected"
            && status === "not_configured"
            && isConfiguredMcpServer(name)
          ) {
            this.deps.deferMcpStatusSessionEviction(sessionId, "mcp_status_connected_to_not_configured");
          }
          console.log(`[sdk] [${sid}] 🔌 MCP ${name}: ${status}${data?.error ? ` — ${data.error}` : ""}`);
          bus.emit({ type: "mcp_status", servers: update.snapshot.servers });
          break;
        }
        default:
          break;
      }
    };

    let unsub: (() => void) | undefined;
    /**
     * Registers this run with the session's feed and starts accepting its events, beginning with
     * any held runtime-started turn: in one tick, so each event is handled once and in order.
     */
    const listenToSession = (activeSession: typeof session) => {
      const feed = this.attachSession(sessionId, activeSession);
      const registration = { controller: runController, handleEvent: (event: any) => handleEvent(event, { origin: "live" }) };
      feed.run = registration;
      unsub = () => {
        if (feed.run === registration) feed.run = undefined;
      };
      beginSend();
      const heldTurn = feed.heldTurn;
      if (!heldTurn) return;
      feed.heldTurn = undefined;
      sendStart = heldTurn.startedAt;
      let next = 0;
      while (next < heldTurn.events.length && !runController.isCompleted()) {
        registration.handleEvent(heldTurn.events[next++]);
      }
      // A later turn held behind this one's end is followed next, when this run lets go.
      const rest = heldTurn.events.slice(next);
      const nextTurn = rest.findIndex((event: any) => event?.type === "assistant.turn_start" && !getSdkAgentId(event));
      if (nextTurn >= 0) {
        feed.heldTurn = { startedAt: getEventTimestampMs(rest[nextTurn]) ?? Date.now(), events: rest.slice(nextTurn) };
      }
    };

    const eventsJsonlPath = join(this.deps.getSessionStateDir(sessionId), "events.jsonl");

    const prepareSessionForSend = async (activeSession: typeof session) => {
      const initialization = this.deps.waitForSessionToolInitialization(sessionId, activeSession);
      if (!(initialization === true || await initialization)) {
        throw new Error(SESSION_TOOL_INITIALIZATION_INCOMPLETE_MESSAGE);
      }
      if (opts.historyTruncation?.mode !== "replace-quiet-interval-defer-tail") return;
      const result = await truncateQuietIntervalDeferTail({
        session: activeSession,
        sessionId,
        deferId: opts.historyTruncation.deferId,
        eventsPath: eventsJsonlPath,
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
      clearEventLogStatsCache(sessionId);
      this.deps.globalBus.emit({ type: "session:history-truncated", sessionId });
    };

    retryStaleCachedSession = async (reason, source) => {
      if (!usedCache || runController.isCompleted()) return;
      if (staleCacheRecoveryPromise) return staleCacheRecoveryPromise;

      const recovery = (async () => {
        const message = getErrorMessage(reason);
        console.warn(
          `[sdk] [${sid}] Stale cached session from ${source} (${message}) — evicting and re-resuming...`,
        );
        acceptingSessionEvents = false;
        unsub?.();
        unsub = undefined;
        await abandonSession(session);
        session = await resumeSession();
        rememberAttentionMode(session);
        staleCacheRetryCount += 1;
        if (!session) {
          if (!runController.isCompleted()) {
            throw new Error("Stale cached session recovery could not resume the session");
          }
          return;
        }
        lastEventTime = Date.now();
        sendStart = lastEventTime;
        resetRunTelemetryState();
        if (runController.isCompleted()) {
          await abandonSession(session);
          return;
        }
        if ((await runStepOrCompletion("prepare session for retry", () => prepareSessionForSend(session))).completed) return;
        if (runController.isCompleted()) return;
        listenToSession(session);
        if (runController.isCompleted()) return;
        if (!opts.execute) throw new Error("Session run is missing an execute step");
        if ((await runSendStep("retry send prompt", () => opts.execute!(session))).completed) return;
        runController.markPromptAccepted();
      })();

      staleCacheRecoveryPromise = recovery;
      try {
        await recovery;
      } finally {
        if (staleCacheRecoveryPromise === recovery) {
          staleCacheRecoveryPromise = undefined;
        }
      }
    };

    const cachedMcp = this.deps.mcpStatus.get(sessionId);
    if (cachedMcp?.complete || cachedMcp?.servers.length) {
      bus.emit({ type: "mcp_status", servers: cachedMcp.servers });
    }
    publishContextSummary(this.deps.sessionContextStore?.getSummary(sessionId) ?? null);

    const heartbeatLog = setInterval(() => {
      const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
      console.log(`[sdk] [${sid}] ⏳ Still working... (${elapsed}s)`);
    }, 30_000);

    let noProgressWarningActive = false;
    let noProgressAbortAttempted = false;
    let backendProbeInFlight = false;

    /** Notes whether events.jsonl changed since the last tick. The first look only sets the baseline. */
    const noteLogProgress = async (): Promise<boolean> => {
      let fileStat: { mtimeMs: number; size: number };
      try {
        fileStat = await stat(eventsJsonlPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      const changed = fileStat.mtimeMs !== lastLogStat?.mtimeMs || fileStat.size !== lastLogStat?.size;
      // A growing log is progress even where the filesystem is slow to move the mtime.
      if (lastLogStat && changed) lastLogGrowthAt = Date.now();
      lastLogStat = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
      const logProgressAt = getLogProgressAt();
      if (logProgressAt > 0) this.deps.runStateController.touchSessionRunIfNewer(sessionId, logProgressAt);
      return changed;
    };

    /**
     * Whether a run is still going is the runtime's call, never the log's: sub-agents share
     * events.jsonl, and it cannot show whether the main agent will start another turn. A running
     * background agent keeps the run alive because the runtime wakes the main agent when it finishes,
     * and so does one that has finished but whose notice has not reached the main agent yet.
     * An attached shell does not: a dev server can outlive every run.
     */
    const askRuntime = async (): Promise<RuntimeAnswer> => {
      try {
        const activity = await session?.getActivity();
        if (!activity) return "unknown";
        if (activity.processing) return "working";
        const tasks = (await session.listTasks())?.tasks;
        if (!tasks) return "unknown";
        const now = Date.now();
        const reportedAt = this.sessionFeeds.get(sessionId)?.agentReportedAt;
        return tasks.some((task: AgentBackgroundTask) => isRunningAgentTask(task) || awaitsWake(task, reportedAt, now)) ? "working" : "idle";
      } catch (error) {
        console.warn(`[sdk] [${sid}] Could not ask the runtime whether the run is still going: ${getErrorMessage(error)}`);
        return "unknown";
      }
    };

    const waitUnlessCompleted = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      void runController.completion.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    /** "idle" only when the runtime says so twice with no main-agent turn starting in between. */
    const askRuntimeTwice = async (): Promise<RuntimeAnswer> => {
      const turnsBefore = liveTurnStartCount;
      const first = await askRuntime();
      if (first !== "idle") return first;
      await waitUnlessCompleted(RUN_ENDED_CONFIRM_MS);
      if (runController.isCompleted() || liveTurnStartCount !== turnsBefore) return "working";
      const second = await askRuntime();
      return liveTurnStartCount === turnsBefore ? second : "working";
    };

    const runWatchdogTick = async () => {
      if (runController.isCompleted()) return;
      try {
        const logChanged = await noteLogProgress();
        // A prompt that is still being delivered has not started the main agent yet.
        if (promptDelivered && !runController.isCompleted()) {
          lastRuntimeAnswer = await askRuntimeTwice();
          if (runController.isCompleted()) return;
          if (lastRuntimeAnswer === "idle" || (lastRuntimeAnswer === "unknown" && logChanged)) {
            const ending = await readPersistedRunEnding(eventsJsonlPath, sendStart);
            // Without the runtime's word, only an ending that leaves no doubt may end the run.
            if (lastRuntimeAnswer === "idle" || ending.conclusive) {
              finishRunFromLog(ending, lastRuntimeAnswer);
              return;
            }
          }
        }
        if (runController.isCompleted()) return;
        let now = Date.now();
        let noProgressMs = Math.max(0, now - getLastProgressAt());
        if (noProgressMs >= NO_PROGRESS_BACKEND_PROBE_MS && this.deps.probeBackendHealth && !backendProbeInFlight) {
          // Zero live events and no disk growth is exactly what a dead RPC
          // channel looks like; a cheap ping distinguishes "slow turn" from
          // "nothing will ever answer" and escalates to disconnect recovery.
          backendProbeInFlight = true;
          const probeStartedAt = Date.now();
          try {
            const healthy = await this.deps.probeBackendHealth("watchdog no-progress");
            recordRunSpan("session.run.backend_probe", Date.now() - probeStartedAt, {
              outcome: healthy ? "healthy" : "unhealthy",
              noProgressMs,
            });
            if (!healthy) {
              console.error(`[sdk] [${sid}] ⚠️ Backend liveness probe failed after ${Math.floor(noProgressMs / 1000)}s without progress; disconnect recovery has been triggered`);
              return;
            }
          } finally {
            backendProbeInFlight = false;
          }
          if (runController.isCompleted()) return;
          now = Date.now();
          noProgressMs = Math.max(0, now - getLastProgressAt());
        }
        if (this.deps.getPendingInteractionCount(sessionId) > 0) {
          // Waiting on the user is not a stall, so it never warns or aborts. Overdue questions get
          // an automatic answer instead; the probe above still catches a dead backend.
          noProgressWarningActive = false;
          await this.deps.autoAnswerOverdueInteractions(sessionId);
          return;
        }
        if (noProgressMs < NO_PROGRESS_WARNING_MS) {
          noProgressWarningActive = false;
          return;
        }

        if (!noProgressWarningActive) {
          noProgressWarningActive = true;
          console.warn(
            `[sdk] [${sid}] ⚠️ No live or persisted progress for ${Math.floor(noProgressMs / 1000)}s; retaining the active session owner`,
          );
          recordRunSpan("session.run.no_progress", 0, {
            noProgressMs,
            warningThresholdMs: NO_PROGRESS_WARNING_MS,
            abortThresholdMs: NO_PROGRESS_ABORT_MS,
          }, now);
        }

        if (noProgressMs < NO_PROGRESS_ABORT_MS || noProgressAbortAttempted) return;
        noProgressAbortAttempted = true;
        console.error(
          `[sdk] [${sid}] ⚠️ No progress for ${Math.floor(noProgressMs / 1000)}s; aborting the existing session turn`,
        );
        recordRunSpan("session.run.no_progress_abort", 0, {
          outcome: "requested",
          noProgressMs,
          abortThresholdMs: NO_PROGRESS_ABORT_MS,
        }, now);
        try {
          const aborted = await this.deps.abortSession(sessionId);
          recordRunSpan("session.run.no_progress_abort", Date.now() - now, {
            outcome: aborted ? "completed" : "run_already_completed",
            noProgressMs,
            abortThresholdMs: NO_PROGRESS_ABORT_MS,
          });
          if (!aborted && !runController.isCompleted()) {
            runController.completeError("Session exceeded the no-progress limit and could not be aborted.");
          }
        } catch (error) {
          const message = getErrorMessage(error);
          recordRunSpan("session.run.no_progress_abort", Date.now() - now, {
            outcome: "failed",
            noProgressMs,
            abortThresholdMs: NO_PROGRESS_ABORT_MS,
            error: message,
          });
          console.error(`[sdk] [${sid}] No-progress abort failed:`, error);
          if (!runController.isCompleted()) {
            runController.completeError(`Session exceeded the no-progress limit and abort failed: ${message}`);
          }
        }
      } catch (error) {
        console.error(`[sdk] [${sid}] Watchdog check failed:`, error);
        recordRunSpan("session.run.watchdog_error", 0, {
          error: getErrorMessage(error),
        });
      }
    };
    const startWatchdogTick = () => {
      if (this.watchdogPromises.has(sessionId)) return;
      const tick = runWatchdogTick();
      this.watchdogPromises.set(sessionId, tick);
      void tick.finally(() => {
        if (this.watchdogPromises.get(sessionId) === tick) {
          this.watchdogPromises.delete(sessionId);
        }
      });
    };
    const watchdog = setInterval(() => {
      startWatchdogTick();
    }, WATCHDOG_INTERVAL_MS);

    try {
      console.log(opts.startLog);

      try {
        if (runController.isCompleted()) return;
        if (!opts.execute) throw new Error("Session run is missing an execute step");
        if (!opts.followsRuntimeTurn && (await runStepOrCompletion("prepare session for send", () => prepareSessionForSend(session))).completed) return;
        if (runController.isCompleted()) return;
        listenToSession(session);
        if (runController.isCompleted()) return;
        if ((await runSendStep("send prompt", () => opts.execute!(session))).completed) return;
        const staleError = pendingStaleSessionError;
        pendingStaleSessionError = undefined;
        if (staleError !== undefined) {
          if (!retryStaleCachedSession) throw new Error("Stale cached session recovery is unavailable");
          await retryStaleCachedSession(staleError, "event");
        } else if (!staleCacheRecoveryPromise) {
          runController.markPromptAccepted();
        } else {
          await staleCacheRecoveryPromise;
        }
      } catch (operationErr) {
        if (usedCache && isStaleAgentSessionError(operationErr)) {
          if (!retryStaleCachedSession) throw new Error("Stale cached session recovery is unavailable");
          const staleError = pendingStaleSessionError ?? operationErr;
          pendingStaleSessionError = undefined;
          await retryStaleCachedSession(staleError, "send");
        } else {
          throw operationErr;
        }
      }

      await runController.completion;
    } finally {
      clearInterval(heartbeatLog);
      clearInterval(watchdog);
      activeExternalTools.clear();
      unsub?.();
    }
  }
}
