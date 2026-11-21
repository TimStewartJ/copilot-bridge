// Run loop, live SDK events, stale-cache retry and run watchdog; SessionManager delegates here.

import type { SessionEvent } from "@github/copilot-sdk";
import type {
  AgentBackend,
  AgentBackgroundTask,
  AgentSession,
  AgentSessionConfig,
  AgentSessionEvent,
  AgentSlashCommandResult,
} from "./agent-backend/index.js";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConnectionError, ConnectionErrors } from "vscode-jsonrpc/node";

import { getGeneratedImageVisuals, getTranscriptCompletion, getVisibleEventTimestamp } from "./event-transform.js";
import { isToolAccompanyingProgress } from "../shared/progress-update.js";
import type { EventBusRegistry, SessionEventBus } from "./event-bus.js";
import { createFusionProgress, FUSION_PROGRESS_EVENT_TYPES } from "./fusion-progress.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { SessionContextStore } from "./session-context-store.js";
import type { ChatMessageIdStore } from "./chat-message-id-store.js";
import type { UnsentMessageStore } from "./unsent-message-store.js";
import type { Task } from "./task-store.js";
import {
  normalizePendingElicitationRequest,
  normalizePendingUserInputRequest,
  PendingInteractionError,
} from "./pending-interaction-validation.js";
import type { PendingUserInputRequestView } from "./user-input-types.js";
import type { BrowserHandoffView } from "../shared/browser-live.js";
import type { PendingElicitationRequestView } from "./elicitation-types.js";
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
  PersistedSessionAttachments,
  RoutedSdkAttachment,
  StartWorkAttachment,
} from "./session-attachment-routing.js";
import type { SessionConfigOptions } from "./session-config-builder.js";
import type { McpServerConfig } from "./mcp-config.js";
import { DEFAULT_SEND_MODE, toSendMode, type AgentMode, type SendMode } from "../shared/send-mode.js";
import {
  CustomAutopilotRun,
  CUSTOM_CONTINUATION_SOURCE,
  isCustomContinuationMessage,
  newContinuationTurnId,
} from "./custom-autopilot.js";
import type { AutomaticAnswerReason } from "../shared/automatic-answer.js";
import { isRecord } from "../shared/is-record.js";
import {
  extractTerminalCompletionFromToolCall,
  type TerminalCompletion,
} from "../shared/terminal-completion.js";
import {
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
import type { ImageBudgetController } from "./image-budget.js";
import {
  normalizePromptCacheBreak,
  promptProcessMetadata,
  type PromptFingerprintConfig,
} from "./session-prompt-fingerprint.js";
import { getParentToolCallId, isStampedAgentTurnEvent, showsAgentTurnsAreStamped } from "./agent-event-ownership.js";
import { TranscriptAgentFold } from "./transcript-agent-fold.js";
import {
  isRetryableProviderError,
  providerErrorMetadata,
  PROVIDER_RETRY_DELAY_MS,
  PROVIDER_RETRY_PROMPT,
} from "./session-provider-retry.js";


const WATCHDOG_INTERVAL_MS = 60_000;
/** The runtime must report idle twice this far apart: autopilot idles ~100 ms between turns. */
const RUN_ENDED_CONFIRM_MS = 10_000;
const NO_PROGRESS_WARNING_MS = 10 * 60_000;
const NO_PROGRESS_ABORT_MS = 60 * 60_000;
/** This long with no live event or disk progress makes the watchdog ping the backend. */
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
/** An agent the runtime will wake the main agent for; unknown statuses count as running. */
const isRunningAgentTask = (task: AgentBackgroundTask): boolean =>
  task.kind === "agent" && !SETTLED_AGENT_TASK_STATUSES.has(task.status);

/** Runtime holds a finished agent's wake notice up to 60 s (CLI 1.0.88) while other work runs. */
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

/** One subscription per cached session, so runtime-started turns are seen with no run open. */
interface SessionFeed {
  session: AgentSession;
  unsubscribe: () => void;
  /** The open run's event handler, registered by `runSessionOperation`. */
  run?: { controller: SessionRunController; handleEvent: (event: SessionEvent) => void };
  /** When the main agent last heard of each background agent: its notice or its read_agent. */
  agentReportedAt: Map<string, number>;
  readAgentCalls: Map<string, string>;
  attentionMode: SessionAttentionMode;
  /** A runtime-started turn's events, held for its run (`claimed`) or the next one if busy. */
  heldTurn?: { startedAt: number; events: SessionEvent[]; claimed?: boolean };
}

type SessionErrorEvent = Extract<SessionEvent, { type: "session.error" }>;

/** The resume config a run reads; the rest of it goes back to the session manager unchanged. */
export type RunResumeConfig = AgentSessionConfig & { mcpServers?: Record<string, McpServerConfig>; model?: string };

/** The runtime's live events: the Copilot backend hands on the SDK's session events unchanged. */
function asSdkSessionEvent(event: AgentSessionEvent): SessionEvent {
  return event as SessionEvent;
}

/** An event's payload, for the fields the Bridge reads from any event type. */
function getEventRecordData(event: unknown): Record<string, unknown> | undefined {
  return isRecord(event) && isRecord(event.data) ? event.data : undefined;
}

/** An event's type as a string, to compare with types the SDK's event list does not name. */
function eventTypeOf(event: SessionEvent): string {
  return event.type;
}

function getEventTimestampMs(event: unknown): number | undefined {
  const rawTimestamp = getEventRecordData(event)?.timestamp ?? (isRecord(event) ? event.timestamp : undefined);
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
import { recordToolFailure } from "./tool-failure-telemetry.js";

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
    // agent-text-audit: error (agent runtime errors)
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
  /** Unattended turn: Home offers a review of it until the user next writes in the chat. */
  origin?: "defer" | "schedule";
  completionAttention?: boolean | CompletionAttentionOptions;
  mode?: SendMode;
  clientMessageId?: string;
  /** Shown instead of `prompt`, so model-only framing (voice context) isn't shown as the user's. */
  displayPrompt?: string;
  /** "system": app-made, not shown as the user's; `automation-*`: shown, but no human authority. */
  promptSource?: "system" | `automation-${string}`;
  /** Reasoning effort for this turn only, set just before the prompt is sent. */
  reasoningEffort?: string;
  /** A person's message: if the run ends before the agent has it, keep it marked not sent. */
  keepUndelivered?: boolean;
}

/** The CLI mode a send runs in: Custom Autopilot is Autopilot with Bridge's minimums on top. */
function agentModeOf(mode: SendMode | undefined): AgentMode {
  if (mode === undefined) return DEFAULT_SEND_MODE;
  return typeof mode === "object" ? "autopilot" : mode;
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

function getSessionShutdownType(data: unknown): string | undefined {
  return isRecord(data) && typeof data.shutdownType === "string" ? data.shutdownType.toLowerCase() : undefined;
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
  // Disposed connection or provider 400 on a prior connection's input item: wrapper is stale.
  // agent-text-audit: error (agent runtime errors)
  return /\bSession not found\b/i.test(message)
    // agent-text-audit: error (agent runtime errors)
    || /Pending response rejected since connection got disposed/i.test(message)
    // agent-text-audit: error (agent runtime errors)
    || /input item ID does not belong to this connection/i.test(message);
}

export interface SessionResumeLease {
  sessionId: string;
  token: symbol;
}

/** A question the runtime has put to the user: the older single question, or a form. */
export type PendingQuestion =
  | { kind: "user_input"; request: PendingUserInputRequestView }
  | { kind: "elicitation"; request: PendingElicitationRequestView };

export interface SessionRunnerDeps {
  /** Lazy accessor for the agent backend; the manager owns lifecycle. */
  getBackend(): AgentBackend | null;
  /** Why the backend can't take work now (rotating, disconnected, not started). */
  getBackendUnavailableReason?(): string | undefined;
  /** Pings the backend RPC channel; false means disconnect recovery has been triggered. */
  probeBackendHealth?(reason: string): Promise<boolean>;
  /** Shared cache of CopilotSession objects (owned by SessionManager). */
  sessionObjects: ReadonlyMap<string, AgentSession>;
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
  /** Records the browser message id each sent chat message was given by the runtime. */
  chatMessageIdStore?: Pick<ChatMessageIdStore, "record">;
  /** Chat messages accepted for a run that the agent has not received yet. */
  unsentMessageStore?: Pick<UnsentMessageStore, "recordPending" | "markUndelivered" | "markSending" | "markSendFailed" | "retire">;
  copilotHome?: string;
  /** A model's display name from the known model list, for status text. */
  modelDisplayName?(modelId: string): string | undefined;
  /** The runtime's skill tool loaded a skill (counted on Settings › Skills). */
  onSkillUsed?(sessionId: string, skillName: string): void;

  isSessionBusy(sessionId: string): boolean;
  hasPlan(sessionId: string): boolean;
  getSessionStateDir(sessionId: string): string;
  buildSessionConfig(opts?: SessionConfigOptions): RunResumeConfig;
  awaitPendingSessionCreation(sessionId: string): Promise<AgentSession | undefined>;
  beginSessionResume(
    sessionId: string,
    sessionConfig: RunResumeConfig,
    isCancelled?: () => boolean,
  ): Promise<SessionResumeLease | null>;
  endSessionResume(lease: SessionResumeLease): void;
  resumeSessionWithTimeout(
    backend: AgentBackend,
    sessionId: string,
    resume: Promise<AgentSession>,
    timeoutMessage: string,
  ): Promise<AgentSession>;
  notifySessionCapacityChanged(): void;
  findLinkedTask(sessionId: string): Task | undefined;
  lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null;
  /** The bridge_context block for the next user message; commit once the SDK accepted it. */
  prepareTurnContext?(sessionId: string): { block?: string; commit(): void };
  /** Forget what was delivered because the conversation may have lost it. */
  resetTurnContext?(sessionId: string): void;
  /** Starts compaction early for models whose provider rejects large requests. */
  imageBudget?: Pick<ImageBudgetController, "attach" | "detach" | "observe">;
  persistAndRouteAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): RoutedSdkAttachment[] | undefined;
  persistSessionAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): PersistedSessionAttachments;
  /** A run let go of the session, so a message waiting for it can start. */
  notifySessionReleased?(sessionId: string): void;
  /** Resumes a runtime session, making it again when the runtime never saved the chat. */
  resumeRuntimeSession(backend: AgentBackend, sessionId: string, resumeConfig: RunResumeConfig): Promise<AgentSession>;
  cacheResumedSession(sessionId: string, session: AgentSession, sessionConfig?: PromptFingerprintConfig): Promise<AgentSession>;
  waitForSessionToolInitialization(sessionId: string, session: AgentSession): boolean | Promise<boolean>;
  abandonCachedSession(sessionId: string, expectedSession: AgentSession): Promise<void>;
  abortSession(sessionId: string): Promise<boolean>;
  markCachedSessionForEviction(sessionId: string, reason: string): void;
  /** Evicts after the run goes idle, not now, so it can't race SDK persistence of this turn. */
  deferMcpStatusSessionEviction(sessionId: string, reason: string): void;
  flushPendingSessionEviction(sessionId: string): void;
  getPendingUserInputCount(sessionId: string): number;
  getPendingInteractionCount(sessionId: string): number;
  /** Answers questions nobody has answered within the wait Bridge allows. Never rejects. */
  autoAnswerOverdueInteractions(sessionId: string): Promise<void>;
  /** The browser handoff a pending form of this chat stands for, when it is one. */
  matchBrowserHandoff?(sessionId: string, request: PendingElicitationRequestView): BrowserHandoffView | undefined;
  /** Answers for the user, unshown: undefined if Bridge won't, else whether the runtime took it. */
  answerQuestionUnshown(
    sessionId: string,
    question: PendingQuestion,
    reason: AutomaticAnswerReason,
  ): Promise<boolean> | undefined;
  /** Answers an invalid question so the run stops waiting; resolves to whether it was taken. */
  answerUnshowableQuestion(
    sessionId: string,
    kind: PendingQuestion["kind"],
    request: unknown,
    problem: string,
  ): Promise<boolean> | undefined;
  recordPendingInteractionEvent(
    sessionId: string,
    kind: "user_input" | "elicitation",
    state: "requested" | "completed",
    at?: string,
  ): void;
  recordSessionAttention(sessionId: string, at?: string): void;
  touchSessionActivity?(sessionId: string, at: number): void;
  /** Switches the live session to the turn's effort. Best effort; never fails the turn. */
  applyTurnReasoningEffort?(sessionId: string, session: AgentSession, reasoningEffort: string): Promise<void>;
  maybeAutoNameSession(
    sessionId: string,
    options: SessionAutoNameOptions<AgentSession>,
  ): void;
}

export class SessionRunner {
  private readonly watchdogPromises = new Map<string, Promise<void>>();
  private readonly sessionFeeds = new Map<string, SessionFeed>();
  private readonly providerRetryWaits = new Map<string, () => void>();
  private lastRuntimeEvent: { receivedAtMs: number; sessionId: string; type: string } | undefined;
  /** Each loaded session's CLI mode; the CLI keeps it, so turns it starts use the last send's. */
  private readonly agentModes = new Map<string, AgentMode>();
  private readonly customRuns = new Map<string, CustomAutopilotRun>();
  private readonly mcpSessionRecoveryAttempts = new Map<string, {
    count: number;
    windowStartedAt: number;
  }>();
  /** Set on first sighting of turn ownership (agent-event-ownership.ts); sticks for later runs. */
  private runtimeStampsAgentTurns = false;

  constructor(private readonly deps: SessionRunnerDeps) {}

  /** The newest event any loaded session's runtime handle delivered, whoever it was for. */
  getLastRuntimeEvent(): { receivedAtMs: number; sessionId: string; type: string } | undefined {
    return this.lastRuntimeEvent;
  }

  async waitForWatchdogIdle(sessionId: string): Promise<void> {
    while (true) {
      const pending = this.watchdogPromises.get(sessionId);
      if (!pending) return;
      await pending;
    }
  }

  cancelProviderRetry(sessionId: string): boolean {
    const cancel = this.providerRetryWaits.get(sessionId);
    if (!cancel) return false;
    cancel();
    return true;
  }

  /** Subscribes once to a cached session's events; SessionManager calls it when caching. */
  attachSession(sessionId: string, session: AgentSession): SessionFeed {
    const current = this.sessionFeeds.get(sessionId);
    if (current?.session === session) return current;
    current?.unsubscribe();
    this.deps.imageBudget?.attach(sessionId, session);
    const feed: SessionFeed = {
      session,
      unsubscribe: () => {},
      agentReportedAt: new Map(),
      readAgentCalls: new Map(),
      attentionMode: "normal",
    };
    this.sessionFeeds.set(sessionId, feed);
    feed.unsubscribe = session.on((event) => this.routeSessionEvent(sessionId, feed, asSdkSessionEvent(event)));
    this.readAgentModeOnAttach(sessionId, session);
    return feed;
  }

  getSessionAgentMode(sessionId: string): AgentMode | undefined {
    return this.agentModes.get(sessionId);
  }

  cancelCustomAutopilot(sessionId: string): void {
    const run = this.customRuns.get(sessionId);
    if (run) run.cancelled = true;
  }

  /** `announce` re-publishes an unchanged mode because lists forget it between runs. */
  private noteAgentMode(sessionId: string, mode: AgentMode | undefined, announce = false): void {
    const previous = this.agentModes.get(sessionId);
    if (mode) this.agentModes.set(sessionId, mode);
    else this.agentModes.delete(sessionId);
    const bus = this.deps.eventBusRegistry.getBus(sessionId);
    const runMode = this.customRuns.get(sessionId)?.mode ?? mode;
    if (bus && !bus.complete) bus.setRunMode(runMode);
    if (mode && (announce || previous !== mode)) {
      this.deps.globalBus.emit({ type: "session:mode", sessionId, agentMode: runMode });
    }
  }

  /** A resumed session keeps its mode silently: ask once; use it if nothing set it meanwhile. */
  private readAgentModeOnAttach(sessionId: string, session: AgentSession): void {
    if (this.agentModes.has(sessionId) || typeof session.getSendMode !== "function") return;
    void session.getSendMode().then((value) => {
      if (this.sessionFeeds.get(sessionId)?.session !== session || this.agentModes.has(sessionId)) return;
      const mode = toSendMode(value);
      if (mode) this.noteAgentMode(sessionId, mode);
    }, () => { /* unknown stays unknown */ });
  }

  /** Drops a held runtime turn of a turn Bridge stopped on purpose (an image-budget pause). */
  discardHeldTurn(sessionId: string): void {
    const feed = this.sessionFeeds.get(sessionId);
    if (feed?.heldTurn && !feed.heldTurn.claimed) feed.heldTurn = undefined;
  }

  /** Ends the subscription as the session leaves the cache. */
  detachSession(sessionId: string, session: AgentSession): void {
    const feed = this.sessionFeeds.get(sessionId);
    if (feed?.session !== session) return;
    feed.unsubscribe();
    this.sessionFeeds.delete(sessionId);
    this.agentModes.delete(sessionId);
    this.deps.imageBudget?.detach(sessionId, session);
  }

  private routeSessionEvent(sessionId: string, feed: SessionFeed, event: SessionEvent): void {
    this.lastRuntimeEvent = { receivedAtMs: Date.now(), sessionId, type: String(event?.type) };
    const mainAgent = !getSdkAgentId(event);
    const at = getEventTimestampMs(event) ?? Date.now();
    if (mainAgent && event?.type === "session.compaction_complete") this.deps.resetTurnContext?.(sessionId);
    if (mainAgent && event?.type === "session.mode_changed") {
      this.noteAgentMode(sessionId, toSendMode(event?.data?.newMode));
    }
    try {
      this.deps.imageBudget?.observe(sessionId, feed.session, event);
    } catch (error) {
      console.warn(`[image-budget] [${sessionId.slice(0, 8)}] Event not counted:`, error instanceof Error ? error.message : error);
    }
    if (mainAgent) this.noteWhatMainAgentHeard(feed, event, at);
    if (feed.run && !feed.run.controller.isCompleted()) {
      feed.run.handleEvent(event);
      return;
    }
    // No run sees it: a command or agent that outlived its run started, finished or was stopped.
    if (event?.type === "session.background_tasks_changed") {
      this.refreshSessionAgents(sessionId, "background_tasks_changed");
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

  private noteWhatMainAgentHeard(feed: SessionFeed, event: SessionEvent, at: number): void {
    const { type, data } = event;
    switch (type) {
      case "system.notification": {
        const kind = data?.kind;
        const agentId = isRecord(kind) ? kind.agentId : undefined;
        if (typeof agentId === "string") feed.agentReportedAt.set(agentId, at);
        break;
      }
      case "tool.execution_start": {
        const args = data?.arguments;
        const agentId = isRecord(args) ? args.agent_id : undefined;
        if (data?.toolName === "read_agent" && typeof agentId === "string" && typeof data?.toolCallId === "string") {
          feed.readAgentCalls.set(data.toolCallId, agentId);
        }
        break;
      }
      case "tool.execution_complete": {
        const agentId = feed.readAgentCalls.get(data?.toolCallId);
        if (agentId === undefined) break;
        feed.readAgentCalls.delete(data.toolCallId);
        // A read before the agent finished is older than its finish, so it still counts as unheard.
        if (data?.success === true) feed.agentReportedAt.set(agentId, at);
        break;
      }
    }
  }

  /** Held while busy; whatever frees the session calls this again, or the next run takes it. */
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
    this.noteAgentMode(sessionId, this.agentModes.get(sessionId), true);
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

  /** Fire-and-forget; the registry coalesces calls and emits only when counts change. */
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
    if (typeof options.mode === "object" && parseSlashCommandPrompt(prompt)) {
      throw new Error("Custom Autopilot needs a prompt, not a slash command.");
    }

    // Saved before anything else: the files are what a message the agent never got is kept with.
    const persistedAttachments = this.deps.persistSessionAttachments(sessionId, attachments);
    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    this.deps.sessionMetaStore?.clearTerminalOverlay(sessionId);
    bus.reset();
    const minimums = typeof options.mode === "object" ? new CustomAutopilotRun(options.mode) : undefined;
    if (minimums) this.customRuns.set(sessionId, minimums);
    this.noteAgentMode(sessionId, agentModeOf(options.mode), true);
    const hiddenPrompt = options.promptSource === "system";
    const visiblePrompt = options.displayPrompt ?? prompt;
    const projectedUserMessageId = hiddenPrompt
      ? undefined
      : bus.setPendingPrompt(visiblePrompt, attachments, options.clientMessageId);
    const keptMessageId = !hiddenPrompt && options.keepUndelivered && options.clientMessageId
      ? this.recordPendingMessage(sessionId, options.clientMessageId, visiblePrompt, persistedAttachments, options.mode)
      : undefined;
    const runController = this.startBackgroundRun(
      sessionId,
      bus,
      (runController) => this.doWork(
        sessionId,
        prompt,
        bus,
        runController,
        attachments,
        options,
        projectedUserMessageId,
        persistedAttachments.routed,
      ).finally(() => {
        if (minimums && this.customRuns.get(sessionId) === minimums) this.customRuns.delete(sessionId);
      }),
      {
        ...(hiddenPrompt ? {} : { pendingPrompt: visiblePrompt }),
        promptAccepted: false,
        attentionMode: options.attentionMode === "quiet" ? "quiet" : "normal",
      },
    );
    if (keptMessageId) this.keepMessageUntilDelivered(sessionId, bus, runController, keptMessageId, projectedUserMessageId);
    return runController;
  }

  /** Records a person's message before its turn; returns its id, or nothing if it was not kept. */
  private recordPendingMessage(
    sessionId: string,
    clientMessageId: string,
    content: string,
    attachments: PersistedSessionAttachments,
    mode: SendMode | undefined,
  ): string | undefined {
    const store = this.deps.unsentMessageStore;
    if (!store) return undefined;
    try {
      store.recordPending({
        sessionId,
        id: clientMessageId,
        content,
        ...(attachments.saved.length > 0 ? { attachments: attachments.saved } : {}),
        ...(mode ? { mode } : {}),
      });
      return clientMessageId;
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Could not record a message before sending it:`, err);
      return undefined;
    }
  }

  /** Publish not-sent before the run's terminal event, which closes the browser stream. */
  private keepMessageUntilDelivered(
    sessionId: string,
    bus: SessionEventBus,
    runController: SessionRunController,
    messageId: string,
    projectedUserMessageId: string | undefined,
  ): void {
    runController.onPromptUndelivered((result) => {
      const state = result.reason === "aborted" ? "stopped" : result.reason === "shutdown" ? "interrupted" : "failed";
      const error = result.reason === "error" ? result.message : undefined;
      // A message the runtime has is the runtime's: its answer settles it, not the stop.
      const kept = this.updateKeptMessage(sessionId, (store) => store.markUndelivered(sessionId, messageId, state, error));
      if (kept && projectedUserMessageId) bus.markPromptUndelivered(projectedUserMessageId, state, error);
    });
    void runController.promptDelivery.then((result) => {
      if (result.status === "accepted") this.retireKeptMessage(sessionId, messageId);
    });
  }

  private retireKeptMessage(sessionId: string, messageId: string): void {
    this.updateKeptMessage(sessionId, (store) => store.retire(sessionId, messageId));
  }

  /** A change to a kept message's record; a store failure is logged and never fails the run. */
  private updateKeptMessage<T>(
    sessionId: string,
    change: (store: NonNullable<SessionRunnerDeps["unsentMessageStore"]>) => T,
  ): T | undefined {
    const store = this.deps.unsentMessageStore;
    if (!store) return undefined;
    try {
      return change(store);
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Could not update a kept chat message:`, err);
      return undefined;
    }
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
    if (this.providerRetryWaits.has(sessionId)) {
      throw new Error("The model provider failed; this chat is waiting to retry. Stop it before sending another message.");
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

    const projectedUserMessageId = bus.setPendingPrompt(prompt, attachments, clientMessageId);
    this.touchSessionRun(sessionId);
    try {
      if (
        runController.isCompleted()
        || this.deps.activeRunControllers.get(sessionId) !== runController
        || this.deps.sessionObjects.get(sessionId) !== session
      ) {
        throw new Error("Session ended before steering could attach; send a normal message instead");
      }
      const messageId = await session.send({
        prompt,
        ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}),
        mode: "immediate",
      });
      this.claimSentUserMessage(sessionId, bus, projectedUserMessageId, messageId, clientMessageId);
      if (runController.isCompleted()) {
        bus.discardPendingPrompt(projectedUserMessageId);
        throw new Error("Session ended before steering could attach; send a normal message instead");
      }
      this.touchSessionRun(sessionId);
      this.recordSpan("session.steer", Date.now() - t0, sessionId, {
        chars: prompt.length,
        attachments: attachCount,
      });
    } catch (error) {
      bus.discardPendingPrompt(projectedUserMessageId);
      throw error;
    }
  }

  /** Ties a prompt to the runtime's message id so `user.message` commits it. Never throws. */
  private claimSentUserMessage(
    sessionId: string,
    bus: SessionEventBus,
    projectedUserMessageId: string | undefined,
    messageId: unknown,
    clientMessageId: string | undefined,
  ): void {
    if (!projectedUserMessageId || typeof messageId !== "string" || !messageId) return;
    bus.assignUserMessageId(projectedUserMessageId, messageId);
    if (!clientMessageId || projectedUserMessageId !== clientMessageId) return;
    try {
      this.deps.chatMessageIdStore?.record(sessionId, messageId, clientMessageId);
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to record the client id of a sent message:`, err);
    }
    // The runtime has it, even when the run was stopped while the send was on its way.
    this.retireKeptMessage(sessionId, clientMessageId);
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
      // Before any pending eviction: a turn the runtime started meanwhile is next.
      this.followRuntimeTurn(sessionId);
      this.deps.notifySessionReleased?.(sessionId);
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
    /** The live entry showing this prompt, from `setPendingPrompt`; absent for hidden prompts. */
    projectedUserMessageId?: string,
    /** `attachments` as already saved and routed by the caller. */
    routedAttachments?: RoutedSdkAttachment[],
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);
    let projectedEntryId = projectedUserMessageId;
    const sdkAttachments = routedAttachments ?? this.deps.persistAndRouteAttachments(sessionId, attachments);
    const attachCount = sdkAttachments?.length ?? 0;
    const activeRunController = runController ?? this.createRunController(sessionId, bus);
    activeRunController.markSendPending();
    const parsedCommand = parseSlashCommandPrompt(prompt);
    let sendPrompt = prompt;
    let displayPrompt: string | undefined = options.displayPrompt;
    let mode: string = agentModeOf(options.mode);
    const minimums = this.customRuns.get(sessionId);
    let commandResult: AgentSlashCommandResult | undefined;

    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "message",
      minimums,
      attentionMode: options.attentionMode ?? "normal",
      completionAttention: options.completionAttention,
      idleSpanName: "session.sendToIdle",
      startLog: `[sdk] [${sid}] Sending ${mode} prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`,
      execute: async (session) => {
        // A Stop can land during any await below; nothing may reach the session after it.
        const stopped = () => activeRunController.isCompleted() || minimums?.cancelled === true;
        if (stopped()) return;
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
          this.noteAgentMode(sessionId, toSendMode(mode) ?? DEFAULT_SEND_MODE);
          projectedEntryId = bus.replacePendingPrompt(displayPrompt ?? sendPrompt);
          this.deps.runStateController.setSessionRunMetadata(sessionId, {
            pendingPrompt: displayPrompt ?? sendPrompt,
          });
        }
        if (stopped()) return;
        if (options.reasoningEffort) {
          await this.deps.applyTurnReasoningEffort?.(sessionId, session, options.reasoningEffort);
          if (stopped()) return;
        }
        await setSessionModeForSend(session, mode);
        if (stopped()) return;
        // Built per attempt from the original prompt: a stale-session retry resends it whole.
        const turnContext = this.deps.prepareTurnContext?.(sessionId);
        activeRunController.markSendStarted();
        const keptMessageId = options.keepUndelivered ? options.clientMessageId : undefined;
        if (keptMessageId) this.updateKeptMessage(sessionId, (store) => store.markSending(sessionId, keptMessageId));
        const turnPrompt = turnContext?.block ? `${turnContext.block}\n\n${sendPrompt}` : sendPrompt;
        const turnDisplayPrompt = turnContext?.block ? displayPrompt ?? sendPrompt : displayPrompt;
        let messageId: unknown;
        try {
          if (minimums) {
            minimums.begin();
            bus.setCustomAutopilotProgress(minimums.progress());
          }
          messageId = await session.send({
            prompt: turnPrompt,
            ...(turnDisplayPrompt ? { displayPrompt: turnDisplayPrompt } : {}),
            ...(options.promptSource ? { source: options.promptSource } : {}),
            ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}),
          });
        } catch (error) {
          // The runtime didn't take it: a retry may resend it, or the run ends with it not sent.
          if (keptMessageId) this.updateKeptMessage(sessionId, (store) => store.markSendFailed(sessionId, keptMessageId));
          throw error;
        }
        turnContext?.commit();
        this.claimSentUserMessage(sessionId, bus, projectedEntryId, messageId, options.clientMessageId);
      },
      retryExecute: async (session, claimSend) => {
        if (options.reasoningEffort) {
          await this.deps.applyTurnReasoningEffort?.(sessionId, session, options.reasoningEffort);
        }
        if (activeRunController.isCompleted()) return;
        await setSessionModeForSend(session, this.agentModes.get(sessionId) ?? mode);
        if (!claimSend()) return;
        const turnContext = this.deps.prepareTurnContext?.(sessionId);
        await session.send({
          prompt: turnContext?.block ? `${turnContext.block}\n\n${PROVIDER_RETRY_PROMPT}` : PROVIDER_RETRY_PROMPT,
          ...(turnContext?.block ? { displayPrompt: PROVIDER_RETRY_PROMPT } : {}),
          source: "system",
        });
        turnContext?.commit();
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
      execute?: (session: AgentSession) => Promise<void>;
      retryExecute?: (session: AgentSession, claimSend: () => boolean) => Promise<void>;
      attentionMode?: SessionAttentionMode;
      completionAttention?: boolean | CompletionAttentionOptions;
      minimums?: CustomAutopilotRun;
      /** The run follows a turn the runtime started: no prompt to prepare or send. */
      followsRuntimeTurn?: boolean;
    },
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);

    const linkedTask = this.deps.findLinkedTask(sessionId);
    const resumeConfig = this.deps.buildSessionConfig({
      sessionId,
      task: linkedTask,
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
    const resumeSession = async (): Promise<AgentSession | null> => {
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
            this.deps.resumeRuntimeSession(this.client!, sessionId, resumeConfig),
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

    const abandonSession = (activeSession: AgentSession) =>
      this.deps.abandonCachedSession(sessionId, activeSession);

    let session = await resumeSession();
    // Stopped before sending: keep the session; dropping it leaves a never-saved chat unresumable.
    if (!session || runController.isCompleted()) return;
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
    // Only to notice agents starting or stopping; the browser reads agents from history.
    const agentLifecycle = new TranscriptAgentFold();
    const subAgentToolCallIds = new Set<string>();
    const activeSubAgentToolCallIds = new Set<string>();
    const subAgentTerminalToolCallIds = new Set<string>();
    const subAgentTurnIdMap = new Map<string, string>();
    const activeExternalTools = new Map<string, ActiveExternalToolCall>();
    const staleMcpServersScheduledThisRun = new Set<string>();
    const contextTelemetryProvider = this.client?.id ?? "copilot";
    const contextTelemetryProviderSessionId = sessionId;
    let currentBridgeTurnId: string | undefined;
    /** A `task_complete` call no event has yet put in the transcript. */
    let pendingTerminalCompletion: TerminalCompletion | undefined;
    /** This run's latest completion that an event has put in the transcript. */
    let recordedTerminalCompletion: TerminalCompletion | undefined;
    const recordTranscriptCompletion = (event: SessionEvent): void => {
      const recorded = getTranscriptCompletion(event, pendingTerminalCompletion);
      if (!recorded) return;
      recordedTerminalCompletion = recorded.completion;
      pendingTerminalCompletion = undefined;
      bus.recordTranscriptCompletion(recorded);
    };
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
    const rememberExternalToolRequest = (data: unknown, eventAt: number) => {
      const fields = isRecord(data) ? data : undefined;
      const requestId = typeof fields?.requestId === "string" && fields.requestId ? fields.requestId : undefined;
      if (!requestId) return;
      const toolName = rememberToolName(fields?.toolCallId, fields?.toolName ?? fields?.name);
      const toolCallId = typeof fields?.toolCallId === "string" && fields.toolCallId
        ? fields.toolCallId
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
    // Main-agent turns only: sub-agents share the stream, but their turns say nothing of the run.
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
    let originalPromptRecorded = false;
    let providerRetryCount = 0;
    let sendSettled = Promise.resolve();
    let pendingProviderRetry: { event: SessionErrorEvent; context: SessionEventHandlingContext } | undefined;
    let providerRetryPromise: Promise<void> | undefined;
    let cancelProviderRetryWait: (() => void) | undefined;
    /** Counts sends, so a watchdog check begun before the latest one can't end its pass. */
    let sendGeneration = 0;
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
      let settleSend!: () => void;
      sendSettled = new Promise<void>((resolve) => { settleSend = resolve; });
      try {
        const result = await runStepOrCompletion(stepName, step);
        if (!result.completed) promptDelivered = true;
        return result;
      } finally {
        sendOperationInFlight = false;
        settleSend();
      }
    };
    const beginSend = () => {
      sendGeneration++;
      sendStart = Date.now();
      lastEventTime = sendStart;
      lastAssistantContent = undefined;
      lastAssistantSourceEventId = undefined;
      pendingTerminalCompletion = undefined;
      recordedTerminalCompletion = undefined;
      activeExternalTools.clear();
      resetRunTelemetryState();
      acceptingSessionEvents = true;
    };

    const getEventTimestampIso = (event: unknown): string | undefined => {
      const eventTime = getEventTimestampMs(event);
      return eventTime === undefined ? undefined : new Date(eventTime).toISOString();
    };
    const publishContextSummary = (summary: ReturnType<SessionContextStore["getSummary"]>): void => {
      if (summary) bus.emit({ type: "context_update", summary });
    };
    /** Any agent's event but the main one's, by any mark the runtime puts on it. */
    const isChildAgentEvent = (event: SessionEvent): boolean => {
      const data = getEventRecordData(event);
      return Boolean(getSdkAgentId(event) || data?.parentToolCallId
        || data?.isSubAgent === true || data?.subagent === true || data?.initiator === "sub-agent"
        || data?.interactionType === "conversation-subagent"
        || (eventTypeOf(event) === "prompt_cache_break" && typeof data?.agentName === "string"));
    };
    const getSubagentContextTurnId = (event: SessionEvent): string | undefined => {
      const data = getEventRecordData(event);
      const agentId = getSdkAgentId(event);
      const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
      const parentToolCallId = typeof data?.parentToolCallId === "string" ? data.parentToolCallId : undefined;
      return (agentId ? subAgentTurnIdMap.get(agentId) : undefined)
        ?? (toolCallId ? subAgentTurnIdMap.get(toolCallId) : undefined)
        ?? (parentToolCallId ? subAgentTurnIdMap.get(parentToolCallId) : undefined);
    };
    const recordLiveContextTelemetry = (event: SessionEvent, live: boolean): void => {
      const store = this.deps.sessionContextStore;
      const data = getEventRecordData(event);
      const subagentTurnId = getSubagentContextTurnId(event);
      const isSubagent = Boolean(subagentTurnId) || isChildAgentEvent(event);
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
    const endCurrentContextTurn = (event: SessionEvent | undefined): void => {
      if (!currentBridgeTurnId) return;
      const model = getEventRecordData(event)?.model;
      this.deps.sessionContextStore?.recordTurnEnd({
        sessionId,
        bridgeTurnId: currentBridgeTurnId,
        endedAt: getEventTimestampIso(event),
        model: typeof model === "string" ? model : undefined,
      });
      currentBridgeTurnId = undefined;
    };
    const shouldRecordCompletionAttention = (reason: "done" | "error"): boolean => {
      const attention = opts.completionAttention;
      if (attention === true) return true;
      if (!attention || typeof attention !== "object") return false;
      return reason === "done" ? attention.done === true : attention.error === true;
    };
    const recordCompletionAttention = (reason: "done" | "error", event: SessionEvent | undefined) => {
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
      providerRetryCount: providerRetryCount || undefined,
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
      event: SessionEvent | undefined,
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
    const completeSessionError = (event: SessionErrorEvent, context: SessionEventHandlingContext) => {
      if (runController.isCompleted()) return;
      const data = event.data;
      console.error(`[sdk] [${sid}] ❌ Error: ${data?.message ?? "unknown"}`);
      endCurrentContextTurn(event);
      recordRunCompletion(event, context, "error", {
        ...providerErrorMetadata(data),
        errorMessagePresent: typeof data?.message === "string",
        errorMessageLength: typeof data?.message === "string" ? data.message.length : undefined,
      });
      recordCompletionAttention("error", event);
      runController.completeError(data?.message ?? "unknown", {
        sourceEventId: getSdkEventId(event),
      });
    };
    const isLiveRunTerminalEvent = (event: SessionEvent): boolean =>
      LIVE_RUN_TERMINAL_EVENT_TYPES.has(event?.type) && !isSdkSubagentSessionError(event);
    const noteLiveEvent = (event: SessionEvent, eventAt: number, origin: SessionEventOrigin) => {
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

    const finishNormally = (event: SessionEvent | undefined, context: SessionEventHandlingContext) => {
      const completion = pendingTerminalCompletion ?? recordedTerminalCompletion;
      const content = completion?.content ?? lastAssistantContent ?? "";
      endCurrentContextTurn(event);
      recordRunCompletion(event, context, "done", {
        finalContentLength: content.length,
        assistantContentKnown: lastAssistantContent !== undefined,
      });
      recordCompletionAttention("done", event);
      runController.completeDone(content, {
        ...(pendingTerminalCompletion ? { terminalCompletion: pendingTerminalCompletion } : {}),
        ...(getSdkEventId(event) ? { sourceEventId: getSdkEventId(event) } : {}),
        ...(lastAssistantSourceEventId ? { assistantSourceEventId: lastAssistantSourceEventId } : {}),
      });
      pendingTerminalCompletion = undefined;
    };

    /** Where a run would end; with a minimum unmet, Bridge sends a keep-going prompt instead. */
    const finishOrContinue = (event: SessionEvent | undefined, context: SessionEventHandlingContext): void => {
      const minimums = opts.minimums;
      if (!minimums) return finishNormally(event, context);
      const endAborted = () => {
        endCurrentContextTurn(event);
        recordRunCompletion(event, context, "aborted", { customContinuations: minimums.continuations });
        runController.completeAborted(lastAssistantContent ?? "", { assistantSourceEventId: lastAssistantSourceEventId });
      };
      if (runController.isCompleted()) return;
      if (minimums.cancelled || (event?.type === "session.idle" && event.data.aborted === true)) return endAborted();
      // As for plain Autopilot, a completion ends the run, but only once every minimum is met.
      if (context.origin === "live" && event?.type === "session.task_complete") {
        if (minimums.decide().kind === "done") finishNormally(event, context);
        return;
      }
      // An idle counts only after this pass's own turn ended; an earlier pass's late one doesn't.
      if (context.origin === "live" && (!liveTurnEndCount || liveAssistantTurnOpen)) return;
      const decision = minimums.decide();
      recordRunSpan("session.custom_autopilot", 0, { outcome: decision.kind, ...minimums.describe() });
      if (decision.kind === "done") return finishNormally(event, context);
      if (decision.kind === "error") {
        endCurrentContextTurn(event);
        recordRunCompletion(event, context, "error", { customContinuations: minimums.continuations });
        recordCompletionAttention("error", event);
        return runController.completeError(decision.error);
      }
      endCurrentContextTurn(event);
      const turnContext = this.deps.prepareTurnContext?.(sessionId);
      // Each pass gets its own provider retry; beginSend makes a late idle of this pass not count.
      providerRetryCount = 0;
      beginSend();
      minimums.noteContinued(decision.promptIndex);
      bus.setCustomAutopilotProgress(minimums.progress());
      void runSendStep("send custom Autopilot continuation", () => session!.send({
        prompt: turnContext?.block ? `${turnContext.block}\n\n${decision.prompt}` : decision.prompt,
        displayPrompt: decision.prompt,
        source: CUSTOM_CONTINUATION_SOURCE,
        clientTurnId: newContinuationTurnId(),
      })).then((sent) => {
        if (!sent.completed) turnContext?.commit();
      }).catch((error) => {
        if (!runController.isCompleted()) runController.completeError(`Custom Autopilot stopped: ${getErrorMessage(error)}`);
      });
    };

    /** Ends a run from the log's ending; the caller has already established that it ended. */
    const finishRunFromLog = (ending: PersistedRunEnding, runtimeAnswer: RuntimeAnswer) => {
      if (runController.isCompleted() || pendingProviderRetry) return;
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
        handleEvent(ending.event!, context);
        return;
      }
      finishOrContinue(ending.event, context);
    };

    /** Questions Bridge answers unshown; their completion from the runtime isn't shown either. */
    const unshownQuestions = new Set<string>();
    /** Shows the user a question, unless the chat is in Autopilot and Bridge answers it at once. */
    const showOrAnswerQuestion = (question: PendingQuestion, show: () => void): void => {
      if (this.agentModes.get(sessionId) !== "autopilot") {
        show();
        return;
      }
      const { requestId } = question.request;
      // Recorded before the reply is sent, so a completion that arrives first finds it.
      unshownQuestions.add(requestId);
      const answering = this.deps.answerQuestionUnshown(sessionId, question, "autopilot");
      if (!answering) {
        unshownQuestions.delete(requestId);
        show();
        return;
      }
      void answering.then((answered) => {
        // Not taken: ask the user after all, unless it completed meanwhile or the run is over.
        if (answered || !unshownQuestions.delete(requestId)) return;
        if (!acceptingSessionEvents || runController.isCompleted()) return;
        show();
      }).catch((error) => {
        console.warn(`[sdk] [${sid}] Could not show ${question.kind} ${requestId} after a failed automatic reply:`, error);
      });
    };
    /** Tells the agent a question it asked cannot be shown, rather than leaving the run waiting. */
    const answerUnshowableQuestion = (kind: PendingQuestion["kind"], request: unknown, error: unknown): void => {
      if (!(error instanceof PendingInteractionError)) {
        console.warn(`[sdk] [${sid}] Ignoring ${kind} request that failed to show:`, error);
        return;
      }
      const problem = error.message;
      console.warn(`[sdk] [${sid}] Cannot show invalid ${kind} request (${problem}); replying to the agent instead`);
      const requestId = isRecord(request) && typeof request.requestId === "string" ? request.requestId : undefined;
      // Recorded before the reply is sent, so a completion that arrives first finds it.
      if (requestId) unshownQuestions.add(requestId);
      const replying = this.deps.answerUnshowableQuestion(sessionId, kind, request, problem);
      if (!requestId) return;
      if (!replying) {
        unshownQuestions.delete(requestId);
        return;
      }
      void replying.then((answered) => {
        if (!answered) unshownQuestions.delete(requestId);
      });
    };

    const fusionProgress = createFusionProgress((modelId) => this.deps.modelDisplayName?.(modelId) ?? modelId);
    const handleEvent = (event: SessionEvent, context: SessionEventHandlingContext) => {
      if (!acceptingSessionEvents || runController.isCompleted()) return;
      const eventAt = Date.now();
      if (context.origin === "live") {
        noteLiveEvent(event, eventAt, context.origin);
        // A background agent left by an earlier prompt can still publish usage in this session.
        const child = opts.minimums ? isChildAgentEvent(event) : false;
        if (opts.minimums && (!child || getSubagentContextTurnId(event))) opts.minimums.observe(event, child);
      }
      const isTerminalEvent = isLiveRunTerminalEvent(event);
      if (!isTerminalEvent) {
        lastEventTime = eventAt;
        this.touchSessionRun(sessionId, eventAt);
      }
      // Destructured together so each case below narrows `data` to its event type's payload.
      const { type: eventType, data } = event;
      // The same payload as a record, for the fields the Bridge reads that the SDK types omit.
      const fields = getEventRecordData(event);
      recordLiveContextTelemetry(event, context.origin === "live");
      if (opts.attentionMode !== "quiet") {
        this.persistLastVisibleActivityAt(sessionId, getVisibleEventTimestamp(event, sessionId));
      }
      if (agentLifecycle.observe(event)) bus.announceAgentChange();
      if (!this.runtimeStampsAgentTurns && showsAgentTurnsAreStamped(event)) this.runtimeStampsAgentTurns = true;
      recordTranscriptCompletion(event);
      switch (eventType) {
        case "user_input.requested": {
          turnHadSideEffects = true;
          try {
            const requestedAt = getEventTimestampIso(event);
            const request = normalizePendingUserInputRequest(data, requestedAt);
            showOrAnswerQuestion({ kind: "user_input", request }, () => {
              bus.emitUserInputRequested(request, requestedAt);
              this.deps.recordPendingInteractionEvent(sessionId, "user_input", "requested", requestedAt);
            });
          } catch (error) {
            answerUnshowableQuestion("user_input", data, error);
          }
          break;
        }
        case "user_input.completed": {
          const requestId = typeof data?.requestId === "string" ? data.requestId : undefined;
          if (!requestId) {
            console.warn(`[sdk] [${sid}] Ignoring user input completion without requestId`);
            break;
          }
          if (unshownQuestions.delete(requestId)) break;
          if (
            fields?.dismissed !== true
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
            const requestedAt = getEventTimestampIso(event);
            const form = normalizePendingElicitationRequest(data, requestedAt);
            const browserHandoff = this.deps.matchBrowserHandoff?.(sessionId, form);
            const request = browserHandoff ? { ...form, browserHandoff } : form;
            showOrAnswerQuestion({ kind: "elicitation", request }, () => {
              bus.emitElicitationRequested(request, requestedAt);
              this.deps.recordPendingInteractionEvent(sessionId, "elicitation", "requested", requestedAt);
            });
          } catch (error) {
            answerUnshowableQuestion("elicitation", data, error);
          }
          break;
        }
        case "elicitation.completed": {
          const requestId = typeof data?.requestId === "string" ? data.requestId : undefined;
          if (!requestId) {
            console.warn(`[sdk] [${sid}] Ignoring elicitation completion without requestId`);
            break;
          }
          if (unshownQuestions.delete(requestId)) break;
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
          if (isCustomContinuationMessage(event)) {
            bus.announceHistoryChange();
            break;
          }
          if (isSdkAgentUserMessage(event)) {
            const agentId = getSdkAgentId(event);
            const content = typeof data?.content === "string"
              ? data.content
              : typeof fields?.prompt === "string"
                ? fields.prompt
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
          const savedMessageId = typeof data?.messageId === "string" && data.messageId
            ? data.messageId
            : undefined;
          if (savedMessageId) {
            bus.recordSavedUserMessage(savedMessageId, getSdkEventId(event), getEventTimestampIso(event));
          } else {
            // Runtimes that do not save the message id: match the prompt by its text instead.
            bus.commitPendingPrompt(
              typeof data?.content === "string"
                ? data.content
                : typeof fields?.prompt === "string"
                  ? fields.prompt
                  : undefined,
              getSdkEventId(event),
              getEventTimestampIso(event),
            );
          }
          if (getSdkEventId(event)) originalPromptRecorded = true;
          runController.markPromptAccepted();
          if (typeof data?.content === "string" && !("source" in (data ?? {}))) {
            this.deps.maybeAutoNameSession(sessionId, { session: session!, userMessages: [data.content] });
          }
          break;
        }
        case "assistant.turn_start":
          if (isStampedAgentTurnEvent(event)) {
            // A turn stamped as a sub-agent's moves that agent's calls, not the main turn.
            const agentId = getSdkAgentId(event);
            const agentToolCallId = getParentToolCallId(event)
              ?? (agentId ? correlator.resolveAgentToolCallId(agentId) : undefined)
              ?? (agentId ? agentLifecycle.getToolCallIdForAgent(agentId) : undefined);
            if (agentToolCallId) {
              bus.emit({
                type: "agent_turn",
                agentToolCallId,
                turnInstanceId: getAssistantTurnInstanceId(event, `subagent-turn-instance-${randomUUID()}`),
              });
            }
            break;
          }
          // Unstamped runtime: with an agent running, take the turn for an agent's.
          if (!this.runtimeStampsAgentTurns && activeSubAgentToolCallIds.size > 0) {
            console.log(`[sdk] [${sid}] ⏳ Sub-agent turn started`);
            break;
          }
          if (pendingProviderRetry) {
            pendingProviderRetry = undefined;
            this.providerRetryWaits.delete(sessionId);
            bus.emit({ type: "provider_retry" });
            recordRunSpan("session.provider.retry", 0, { outcome: "runtime_continued" });
            beginSend();
            promptDelivered = true;
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
          if (getSdkAgentId(event) || fields?.parentToolCallId) break;
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
          // Full block after its deltas: repairs missed ones (reconnect, non-streaming model).
          if (getSdkAgentId(event) || fields?.parentToolCallId) break;
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
          // Only `reasoningText` reaches events.jsonl, so the live block takes its disk id now.
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
            const progressUpdate = isToolAccompanyingProgress(data?.toolRequests);
            bus.emit({
              type: "assistant_partial",
              content: data.content ?? "",
              ...(progressUpdate ? { progressUpdate: true } : {}),
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
            rememberToolName(data?.toolCallId, data?.toolName ?? fields?.name),
          );
          console.log(`[sdk] [${sid}] 🧰 External tool requested: ${toolName}`);
          break;
        }
        case "external_tool.completed":
          clearExternalToolRequest(data?.requestId, eventAt);
          break;
        case "tool.execution_start": {
          turnHadSideEffects = true;
          const toolName = data?.toolName ?? (typeof fields?.name === "string" ? fields.name : undefined) ?? "unknown";
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
          if (toolName === "skill" && !data?.parentToolCallId) {
            const skillArgs = data?.arguments;
            const skillName = isRecord(skillArgs) && typeof skillArgs.skill === "string" ? skillArgs.skill : undefined;
            if (skillName) {
              try {
                this.deps.onSkillUsed?.(sessionId, skillName);
              } catch (error) {
                console.warn(`[sdk] [${sid}] Could not record skill use:`, error instanceof Error ? error.message : error);
              }
            }
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
              rememberToolName(data?.toolCallId, fields?.toolName ?? fields?.name),
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
              rememberToolName(data?.toolCallId, fields?.toolName ?? fields?.name),
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
          const toolStart = toolStartTimes.get(data?.toolCallId);
          const failure = ok ? undefined : recordToolFailure(
            resolution.error ?? { error: data?.error, result: data?.result },
            {
              sessionId,
              toolName: completedToolName,
              toolCallId: completedToolCallId,
              durationMs: toolStart === undefined ? 0 : Date.now() - toolStart,
            },
            (name, duration, id, metadata) => this.deps.telemetryStore?.recordSpan({
              name, duration, sessionId: id, metadata, source: "server",
            }),
          );
          console.log(`[sdk] [${sid}] 🔧 Tool complete: ${outcome.displayName} (${ok ? "ok" : `failed:${failure!.category}`})`);
          if (failure) {
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
          for (const visual of getGeneratedImageVisuals(
            event,
            completedToolName,
            sessionId,
            completedToolCallId ? toolArgsMap.get(completedToolCallId) : undefined,
          )) {
            bus.emit({ type: "visual_published", ...visual, timestamp: event.timestamp });
          }
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
          // The correlator ignores this for a background launch, already sealed as successful.
          if (eventType === "subagent.failed" && subagentToolCallId) {
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
            // Repeat ends lack correlation; emitting would relabel the agent row "task".
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
          // `session.idle` follows unless an agent or shell defers it, so ask the runtime now.
          if (!getSdkAgentId(event)) {
            // Until it starts another turn, the main agent is waiting on that background work.
            bus.emit({ type: "main_idle" });
            startWatchdogTick();
          }
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
          recordRunSpan("session.provider.error", 0, {
            ...providerErrorMetadata(data),
            model: this.deps.sessionContextStore?.getSummary(sessionId)?.currentModel ?? resumeConfig.model,
          });
          if (pendingProviderRetry && getSdkEventId(event)
            && getSdkEventId(event) === getSdkEventId(pendingProviderRetry.event)) break;
          if (
            context.origin === "live"
            && opts.retryExecute
            && !opts.minimums?.cancelled
            && originalPromptRecorded
            && providerRetryCount === 0
            && isRetryableProviderError(data)
          ) {
            endCurrentContextTurn(event);
            scheduleProviderRetry(event, context);
            break;
          }
          if (
            usedCache
            && !opts.followsRuntimeTurn
            && !opts.minimums?.continuations
            && isStaleAgentSessionError(data?.message)
            && !turnHadSideEffects
            && !runController.isCompleted()
          ) {
            // Post-send provider errors come as events: refresh the stale wrapper before surfacing.
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
            const message = fields?.message ?? fields?.reason ?? "session shutdown";
            console.error(`[sdk] [${sid}] ❌ Shutdown(error): ${message}`);
            recordRunCompletion(event, context, "error", {
              shutdownType,
              errorMessagePresent: typeof fields?.message === "string" || typeof fields?.reason === "string",
              errorMessageLength: typeof message === "string" ? message.length : undefined,
            });
            runController.completeError(String(message), {
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
          if (pendingProviderRetry) break;
          if (providerRetryCount > 0 && context.origin === "live") {
            // A failed try's late idle can't end the retry: ask the runtime, as the watchdog does.
            startWatchdogTick();
            break;
          }
          if (staleMcpServersScheduledThisRun.size > 0) {
            this.deps.mcpStatus.delete(sessionId);
          }
          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          // The bus carries a recorded completion to the run's ending with its transcript identity.
          const completion = pendingTerminalCompletion ?? recordedTerminalCompletion;
          const content = completion?.content ?? lastAssistantContent ?? "";
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
          console.log(`[sdk] [${sid}] 💤 ${event.type}: ${content.length} chars (${elapsed}s)`);
          this.recordSpan(opts.idleSpanName, Date.now() - sendStart, sessionId, { chars: content.length });
          finishOrContinue(event, context);
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
          // A sub-agent's Fusion turn is its own, and a log replay has no live status to show.
          if (FUSION_PROGRESS_EVENT_TYPES.has(event.type) && context.origin === "live" && !getSdkAgentId(event)) {
            const status = fusionProgress.observe(event);
            if (status !== undefined) {
              bus.emit({ type: "intent", intent: status });
              this.deps.globalBus.emit({ type: "session:intent", sessionId, intent: status });
            }
          }
          break;
      }
    };

    let unsub: (() => void) | undefined;
    /** Joins the feed, held turn first, in one tick so each event is handled once and in order. */
    const listenToSession = (activeSession: AgentSession) => {
      const feed = this.attachSession(sessionId, activeSession);
      const registration = { controller: runController, handleEvent: (event: SessionEvent) => handleEvent(event, { origin: "live" }) };
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
      const nextTurn = rest.findIndex((event) => event?.type === "assistant.turn_start" && !getSdkAgentId(event));
      if (nextTurn >= 0) {
        feed.heldTurn = { startedAt: getEventTimestampMs(rest[nextTurn]) ?? Date.now(), events: rest.slice(nextTurn) };
      }
    };

    const eventsJsonlPath = join(this.deps.getSessionStateDir(sessionId), "events.jsonl");

    const prepareSessionForSend = async (activeSession: AgentSession) => {
      const initialization = this.deps.waitForSessionToolInitialization(sessionId, activeSession);
      if (!(initialization === true || await initialization)) {
        throw new Error(SESSION_TOOL_INITIALIZATION_INCOMPLETE_MESSAGE);
      }
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
        await abandonSession(session!);
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
        if ((await runStepOrCompletion("prepare session for retry", () => prepareSessionForSend(session!))).completed) return;
        if (runController.isCompleted()) return;
        listenToSession(session);
        if (runController.isCompleted()) return;
        if (!opts.execute) throw new Error("Session run is missing an execute step");
        if ((await runSendStep("retry send prompt", () => opts.execute!(session!))).completed) return;
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

    /** Whether events.jsonl changed since the last tick; the first look only sets the baseline. */
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

    /** Ask the runtime, not the log: agents and pending wake notices keep a run; shells don't. */
    const askRuntime = async (): Promise<RuntimeAnswer> => {
      try {
        const activity = await session?.getActivity();
        if (!activity) return "unknown";
        if (activity.processing) return "working";
        const tasks = (await session!.listTasks())?.tasks;
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

    const scheduleProviderRetry = (event: SessionErrorEvent, context: SessionEventHandlingContext) => {
      const pending = { event, context };
      pendingProviderRetry = pending;
      providerRetryCount += 1;
      const retryAt = new Date(Date.now() + PROVIDER_RETRY_DELAY_MS).toISOString();
      const failedSendSettled = sendSettled;
      bus.emit({ type: "provider_retry", providerRetry: { phase: "waiting", retryAt } });
      recordRunSpan("session.provider.retry", 0, {
        ...providerErrorMetadata(event.data),
        outcome: "scheduled",
        retryAt,
      });
      console.warn(`[sdk] [${sid}] Provider internal server error — retrying once in 5 seconds`);
      cancelProviderRetryWait = () => {
        pendingProviderRetry = undefined;
        this.providerRetryWaits.delete(sessionId);
        recordRunSpan("session.provider.retry", 0, { outcome: "cancelled" });
        runController.completeAborted(bus.getStreamingContent() || bus.getLastAssistantSegment()?.content || "");
      };
      this.providerRetryWaits.set(sessionId, cancelProviderRetryWait);
      providerRetryPromise = (async () => {
        await waitUnlessCompleted(PROVIDER_RETRY_DELAY_MS);
        if (runController.isCompleted() || pendingProviderRetry !== pending) return;
        if ((await runStepOrCompletion("settle failed provider send", () => failedSendSettled)).completed) return;
        if (runController.isCompleted() || pendingProviderRetry !== pending) return;
        const readiness = await runStepOrCompletion<Awaited<ReturnType<AgentSession["getActivity"]>>>(
          "check runtime before provider retry", () => session!.getActivity(),
        );
        if (runController.isCompleted() || pendingProviderRetry !== pending || readiness.completed) return;
        if (readiness.value?.processing !== false || this.deps.sessionObjects.get(sessionId) !== session) {
          pendingProviderRetry = undefined;
          this.providerRetryWaits.delete(sessionId);
          recordRunSpan("session.provider.retry", 0, { outcome: "not_ready" });
          completeSessionError(event, context);
          return;
        }
        const claimSend = () => {
          if (runController.isCompleted() || pendingProviderRetry !== pending || opts.minimums?.cancelled) return false;
          pendingProviderRetry = undefined;
          this.providerRetryWaits.delete(sessionId);
          beginSend();
          bus.emit({ type: "provider_retry", providerRetry: { phase: "retrying", retryAt } });
          recordRunSpan("session.provider.retry", 0, { outcome: "started" });
          return true;
        };
        if ((await runSendStep("send provider retry", () => opts.retryExecute!(session!, claimSend))).completed) return;
        runController.markPromptAccepted();
        startWatchdogTick();
      })().catch((error) => {
        if (runController.isCompleted()) return;
        console.error(`[sdk] [${sid}] Automatic provider retry failed:`, error);
        recordRunSpan("session.provider.retry", 0, { outcome: "failed" });
        runController.completeError(`Automatic retry failed: ${getErrorMessage(error)}`);
      });
    };

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
      if (runController.isCompleted() || pendingProviderRetry) return;
      const generation = sendGeneration;
      try {
        const logChanged = await noteLogProgress();
        // A prompt that is still being delivered has not started the main agent yet.
        if (promptDelivered && !runController.isCompleted()) {
          lastRuntimeAnswer = await askRuntimeTwice();
          if (runController.isCompleted() || pendingProviderRetry || generation !== sendGeneration) return;
          if (lastRuntimeAnswer === "idle" || (lastRuntimeAnswer === "unknown" && logChanged)) {
            const ending = await readPersistedRunEnding(eventsJsonlPath, sendStart);
            if (generation !== sendGeneration || runController.isCompleted()) return;
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
          // Silence plus no disk growth may be a dead RPC channel; a ping escalates to recovery.
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
          // Waiting on the user isn't a stall; overdue questions get an automatic answer instead.
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
        if (!opts.followsRuntimeTurn && (await runStepOrCompletion("prepare session for send", () => prepareSessionForSend(session!))).completed) return;
        if (runController.isCompleted()) return;
        listenToSession(session);
        if (runController.isCompleted()) return;
        if ((await runSendStep("send prompt", () => opts.execute!(session!))).completed) return;
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
      pendingProviderRetry = undefined;
      if (this.providerRetryWaits.get(sessionId) === cancelProviderRetryWait) this.providerRetryWaits.delete(sessionId);
      clearInterval(heartbeatLog);
      clearInterval(watchdog);
      activeExternalTools.clear();
      unsub?.();
      await providerRetryPromise;
    }
  }
}
