import { randomUUID } from "node:crypto";

// Event bus for session streaming — decouples work from HTTP responses
// Tracks snapshot of current in-flight turn, streams live events to subscribers

import type {
  NativeUserInputResponse,
  PendingUserInputRequestView,
  UserInputCancelReason,
  UserInputRequestId,
} from "./user-input-types.js";
import type {
  ElicitationAction,
  ElicitationCancelReason,
  ElicitationRequestId,
  PendingElicitationRequestView,
} from "./elicitation-types.js";
import type { SessionContextSummary } from "../shared/session-context.js";
import type { AgentInstruction } from "../shared/subagent.js";
import {
  extractTerminalCompletionFromToolCall,
  type TerminalCompletion,
} from "../shared/terminal-completion.js";
import type { StartWorkAttachment } from "./session-attachment-routing.js";

export type {
  NativeUserInputRequest,
  NativeUserInputResponse,
  UserInputCancelReason,
  UserInputAnsweredStreamEvent,
  UserInputCanceledStreamEvent,
  PendingUserInputRequestView,
  UserInputAnswerEndpointPayload,
  UserInputChoice,
  UserInputRequestedStreamEvent,
  UserInputRequestId,
  UserInputSnapshotState,
  UserInputStreamEvent,
} from "./user-input-types.js";
export type {
  ElicitationAction,
  ElicitationCanceledStreamEvent,
  ElicitationMode,
  ElicitationRequestId,
  ElicitationResolvedStreamEvent,
  ElicitationResponseEndpointPayload,
  ElicitationSchema,
  ElicitationSchemaField,
  ElicitationSnapshotState,
  ElicitationStreamEvent,
  NativeElicitationRequest,
  NativeElicitationResult,
  PendingElicitationRequestView,
  SubmittedElicitationResponse,
} from "./elicitation-types.js";

export interface StreamEvent {
  type: string;
  content?: string;
  name?: string;
  message?: string;
  intent?: string;
  turnId?: string;
  turnInstanceId?: string;
  summary?: SessionContextSummary;
  [key: string]: unknown;
}

/**
 * A tool call the stream knows about. Includes recently-completed calls so a result can render
 * immediately; the client substitutes this state onto the matching disk entry rather than
 * appending a second copy, so `events.jsonl` still decides where the tool sits in the transcript.
 */
export interface LiveTool {
  toolCallId: string;
  name: string;
  turnId?: string;
  turnInstanceId?: string;
  sourceEventId?: string;
  args?: unknown;
  startedAt?: string;
  progressText?: string;
  parentToolCallId?: string;
  isSubAgent?: boolean;
  agentInstructions?: AgentInstruction[];
  completedAt?: string;
  success?: boolean;
  result?: unknown;
}

/** A visual published this run, retired once its `artifactId` appears in disk history. */
export interface LiveVisual {
  artifactId: string;
  kind?: string;
  title?: string;
  displayName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  downloadUrl?: string;
  source?: string;
  caption?: string;
  altText?: string;
  timestamp?: string;
  turnId?: string;
  turnInstanceId?: string;
}

/** A completion card for the current run, retired once its source event appears in disk history. */
export interface LiveCompletion {
  completion: TerminalCompletion;
  sourceEventId?: string;
  timestamp?: string;
  turnId?: string;
  turnInstanceId?: string;
}

/**
 * Assistant text held on the stream until `events.jsonl` catches up. A segment with a
 * `sourceEventId` is disk-backed and the client drops it once that id appears in loaded history.
 * A segment without one is bridge-native (for example slash-command output that never reaches the
 * SDK) and therefore has no disk representation at all.
 */
export interface LiveAssistantSegment {
  id: string;
  content: string;
  sourceEventId?: string;
  /**
   * True only for text the bridge produced itself (for example slash-command output that never
   * reached the SDK). Such text has no `events.jsonl` representation, so it is never handed off to
   * disk history and survives turn boundaries.
   */
  bridgeNative?: boolean;
  turnId?: string;
  turnInstanceId?: string;
  timestamp?: string;
}

export type RunNoticeKind = "stopped" | "interrupted" | "error" | "command";

/**
 * Bridge-native run outcome with no `events.jsonl` representation. Rendered as a notice below the
 * transcript instead of being injected into it, so disk stays the only transcript authority.
 */
export interface RunNotice {
  kind: RunNoticeKind;
  content?: string;
  message?: string;
  timestamp?: string;
}

/**
 * Ephemeral run state only. Committed transcript content and ordering come from `events.jsonl`
 * via `/messages-fast`; nothing here re-projects it.
 */
export interface BusSnapshot {
  type: "snapshot";
  runId: string;
  complete: boolean;
  /** Assistant text streamed since the last persisted assistant message. */
  streamingContent: string;
  liveAssistantSegments: LiveAssistantSegment[];
  /** Prompts accepted by the bridge; each clears once its `sourceEventId` reaches disk history. */
  pendingUserMessages: ProjectedUserMessage[];
  /** In-flight and recently-completed tool calls, keyed by `toolCallId`. */
  liveTools: LiveTool[];
  /** Visuals published this run that disk history may not have surfaced yet. */
  liveVisuals: LiveVisual[];
  /** Completion card for this run, if one was produced. */
  liveCompletion?: LiveCompletion;
  intentText: string;
  turnId?: string;
  turnInstanceId?: string;
  contextSummary: SessionContextSummary | null;
  /** Pending native user input requests only; answered/canceled requests are omitted. */
  pendingUserInputs: PendingUserInputRequestView[];
  /** Pending native elicitation requests only; resolved/canceled requests are omitted. */
  pendingElicitations: PendingElicitationRequestView[];
  runNotice?: RunNotice;
  terminalType?: "done" | "error" | "aborted" | "shutdown";
  terminalTimestamp?: string;
  [key: string]: unknown;
}

/** Server-only terminal detail retained for abort fallback and terminal-overlay persistence. */
export interface BusTerminalState {
  runId: string;
  complete: boolean;
  terminalType?: "done" | "error" | "aborted" | "shutdown";
  terminalTimestamp?: string;
  terminalEventId?: string;
  terminalAssistantEventId?: string;
  finalContent?: string;
  errorMessage?: string;
  terminalCompletion?: TerminalCompletion;
  turnId?: string;
  turnInstanceId?: string;
  runNotice?: RunNotice;
}

/** A point-in-time listing of the interaction requests still awaiting a response. */
export interface PendingInteractionSnapshot {
  pendingUserInputs: PendingUserInputRequestView[];
  pendingElicitations: PendingElicitationRequestView[];
}

export interface ProjectedUserMessage {
  id: string;
  content: string;
  attachments?: StartWorkAttachment[];
  pending: boolean;
  sourceEventId?: string;
  timestamp?: string;
}


type Listener = (event: StreamEvent) => void;

const CLEANUP_DELAY = 5 * 60_000;

interface UserInputCanceledOptions {
  reason?: UserInputCancelReason;
  message?: string;
  timestamp?: string;
}

interface ElicitationCanceledOptions {
  reason?: ElicitationCancelReason;
  message?: string;
  timestamp?: string;
}



export interface TerminalNoticeOptions {
  terminalType: "done" | "error" | "aborted" | "shutdown";
  terminalSourceEventId?: string;
  assistantSourceEventId?: string;
  content?: string;
  message?: string;
  timestamp?: string;
  terminalCompletion?: TerminalCompletion;
}

/**
 * Build the bridge-native run notice for a terminal event. Anything already represented in
 * `events.jsonl` (normal assistant replies, `task_complete` completion cards) yields no notice —
 * disk stays the sole transcript authority. Only content the SDK never persisted, or a run outcome
 * with no disk representation, becomes a notice.
 */
export function createRunNotice(options: TerminalNoticeOptions): RunNotice | undefined {
  const timestamp = options.timestamp ? { timestamp: options.timestamp } : {};
  if (options.terminalType === "error") {
    return { kind: "error", message: options.message || "Unknown session error", ...timestamp };
  }
  if (options.terminalType === "aborted" || options.terminalType === "shutdown") {
    const kind = options.terminalType === "aborted" ? "stopped" : "interrupted";
    // Partial text only reached disk if the SDK persisted an assistant message for it. Otherwise
    // the stream is its only copy, so carry it on the notice.
    const unpersistedContent = options.assistantSourceEventId ? undefined : options.content;
    return {
      kind,
      ...(unpersistedContent ? { content: unpersistedContent } : {}),
      ...timestamp,
    };
  }
  // A `done` run with no SDK terminal event never reached the SDK (for example a slash command
  // answered locally), so its output exists only here.
  if (options.terminalSourceEventId || options.terminalCompletion) return undefined;
  if (!options.content) return undefined;
  return { kind: "command", content: options.content, ...timestamp };
}

function getStreamTurnId(event: StreamEvent): string | undefined {
  return typeof event.turnId === "string" && event.turnId ? event.turnId : undefined;
}

function getStreamTurnInstanceId(event: StreamEvent): string | undefined {
  return typeof event.turnInstanceId === "string" && event.turnInstanceId
    ? event.turnInstanceId
    : undefined;
}

function isTerminalStreamEvent(event: StreamEvent): boolean {
  return event.type === "done"
    || event.type === "error"
    || event.type === "aborted"
    || event.type === "shutdown";
}

/**
 * Events the SDK also persists to `events.jsonl` as a visible transcript entry. Observing one means
 * the disk-backed history has advanced and subscribers should refresh their committed window.
 */
function isCommittedHistoryEvent(event: StreamEvent): boolean {
  if (event.type === "tool_start" || event.type === "tool_done" || event.type === "visual_published") {
    return true;
  }
  if (event.type === "assistant_partial") return typeof event.sourceEventId === "string";
  return isTerminalStreamEvent(event);
}

function isTurnScopedStreamEvent(event: StreamEvent): boolean {
  return event.type === "delta"
    || event.type === "intent"
    || event.type === "assistant_partial"
    || event.type === "tool_start"
    || event.type === "tool_update"
    || event.type === "tool_progress"
    || event.type === "tool_output"
    || event.type === "tool_done"
    || event.type === "done"
    || event.type === "aborted"
    || event.type === "shutdown"
    || event.type === "error";
}

function getToolCallId(event: StreamEvent): string {
  return typeof event.toolCallId === "string" ? event.toolCallId : "";
}

function buildLiveTool(event: StreamEvent): LiveTool {
  const turnId = getStreamTurnId(event);
  const turnInstanceId = getStreamTurnInstanceId(event);
  return {
    toolCallId: getToolCallId(event),
    name: event.name ?? "unknown",
    ...(turnId ? { turnId } : {}),
    ...(turnInstanceId ? { turnInstanceId } : {}),
    ...(typeof event.sourceEventId === "string" ? { sourceEventId: event.sourceEventId } : {}),
    args: event.args,
    startedAt: event.timestamp as string | undefined,
    parentToolCallId: event.parentToolCallId as string | undefined,
    isSubAgent: event.isSubAgent as boolean | undefined,
    agentInstructions: event.agentInstructions as AgentInstruction[] | undefined,
  };
}

function mergeLiveTool(existing: LiveTool, patch: Partial<LiveTool>): LiveTool {
  const merged: LiveTool = {
    ...existing,
    name: patch.name ?? existing.name,
  };
  if (patch.turnId !== undefined) merged.turnId = patch.turnId;
  if (patch.turnInstanceId !== undefined) merged.turnInstanceId = patch.turnInstanceId;
  if (existing.sourceEventId === undefined && patch.sourceEventId !== undefined) {
    merged.sourceEventId = patch.sourceEventId;
  }
  if (patch.args !== undefined) merged.args = patch.args;
  if (patch.startedAt !== undefined) merged.startedAt = patch.startedAt;
  if (patch.progressText !== undefined) merged.progressText = patch.progressText;
  if (patch.parentToolCallId !== undefined) merged.parentToolCallId = patch.parentToolCallId;
  if (patch.isSubAgent !== undefined) merged.isSubAgent = patch.isSubAgent;
  if (patch.agentInstructions !== undefined) merged.agentInstructions = patch.agentInstructions;
  if (patch.completedAt !== undefined) merged.completedAt = patch.completedAt;
  if (patch.success !== undefined) merged.success = patch.success;
  if (patch.result !== undefined) merged.result = patch.result;
  return merged;
}


function upsertLiveTool(tools: LiveTool[], nextTool: LiveTool): LiveTool[] {
  const existingIndex = tools.findIndex((tool) => tool.toolCallId === nextTool.toolCallId);
  if (existingIndex < 0) return [...tools, nextTool];
  return tools.map((tool, index) => index === existingIndex ? mergeLiveTool(tool, nextTool) : tool);
}


function patchLiveTools(tools: LiveTool[], toolCallId: string, patch: Partial<LiveTool>): LiveTool[] {
  return tools.map((tool) => tool.toolCallId === toolCallId ? mergeLiveTool(tool, patch) : tool);
}


export class SessionEventBus {
  private listeners = new Set<Listener>();
  private _complete = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  // Ephemeral run state only — committed transcript content comes from events.jsonl.
  private runId = randomUUID();
  private streamingContent = "";
  private userMessages: ProjectedUserMessage[] = [];
  private liveAssistantSegments: LiveAssistantSegment[] = [];
  private liveTools: LiveTool[] = [];
  private liveVisuals: LiveVisual[] = [];
  private liveCompletion?: LiveCompletion;
  private intentText = "";
  private runNotice?: RunNotice;
  /**
   * Runtime-owned pending interactions this run, keyed by the runtime's own
   * request id. Deliberately NOT reset on turn boundaries: an `ask_user` prompt
   * blocks inside its tool call while the surrounding run keeps streaming, so
   * only explicit resets, terminal cleanup, and disposal may clear it.
   */
  private pendingUserInputIndex = new Map<UserInputRequestId, PendingUserInputRequestView>();
  private pendingElicitationIndex = new Map<ElicitationRequestId, PendingElicitationRequestView>();
  /** Server-only: last assistant text observed this run, used for abort/shutdown fallback. */
  private lastAssistantSegment?: LiveAssistantSegment;
  private finalContent?: string;
  private terminalCompletion?: TerminalCompletion;
  /**
   * Pending terminal completion captured from a hidden `task_complete` tool start. Carried into the
   * terminal event (done/aborted/shutdown/error) so abnormal endings surface the agent's summary,
   * matching disk replay. Cleared when a new turn starts.
   */
  private pendingTerminalCompletion?: TerminalCompletion;
  private errorMessage?: string;
  private terminalType?: "done" | "error" | "aborted" | "shutdown";
  private terminalTimestamp?: string;
  private terminalEventId?: string;
  private terminalAssistantEventId?: string;
  private mcpServers: unknown[] = [];
  private currentTurnId?: string;
  private terminalTurnId?: string;
  private currentTurnInstanceId?: string;
  private terminalTurnInstanceId?: string;
  private contextSummary: SessionContextSummary | null = null;

  constructor(
    private sessionId: string,
    private onCleanup?: (sessionId: string) => void,
  ) {}

  getIntentText(): string {
    return this.intentText;
  }

  /** Last assistant text observed on this run, including text not yet persisted to disk. */
  getLastAssistantSegment(): LiveAssistantSegment | undefined {
    return this.lastAssistantSegment ? { ...this.lastAssistantSegment } : undefined;
  }

  /** Streamed assistant text that has not yet been finalized into an assistant message. */
  getStreamingContent(): string {
    return this.streamingContent;
  }

  getTerminalState(): BusTerminalState {
    return {
      runId: this.runId,
      complete: this._complete,
      ...(this.terminalType ? { terminalType: this.terminalType } : {}),
      ...(this.terminalTimestamp ? { terminalTimestamp: this.terminalTimestamp } : {}),
      ...(this.terminalEventId ? { terminalEventId: this.terminalEventId } : {}),
      ...(this.terminalAssistantEventId
        ? { terminalAssistantEventId: this.terminalAssistantEventId }
        : {}),
      ...(this.finalContent ? { finalContent: this.finalContent } : {}),
      ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
      ...(this.terminalCompletion ? { terminalCompletion: this.terminalCompletion } : {}),
      ...(this.currentTurnId ?? this.terminalTurnId
        ? { turnId: this.currentTurnId ?? this.terminalTurnId }
        : {}),
      ...(this.currentTurnInstanceId ?? this.terminalTurnInstanceId
        ? { turnInstanceId: this.currentTurnInstanceId ?? this.terminalTurnInstanceId }
        : {}),
      ...(this.runNotice ? { runNotice: { ...this.runNotice } } : {}),
    };
  }

  /**
   * Announce that an observed event will become a committed history entry, so subscribers can
   * refresh the disk-backed transcript instead of receiving a duplicate live projection. The
   * signal carries no payload: the client owns its own refresh epoch.
   */
  private advanceHistory(): void {
    this.broadcast({ type: "history_advanced" });
  }

  /** Add a server-owned user entry before the SDK persists it. */
  setPendingPrompt(prompt: string, attachments?: StartWorkAttachment[], messageId?: string): string {
    const userMessage: ProjectedUserMessage = {
      id: messageId ?? randomUUID(),
      content: prompt,
      pending: true,
      ...(attachments?.length ? { attachments: structuredClone(attachments) } : {}),
    };
    this.userMessages = [...this.userMessages, userMessage];
    this.broadcast({ type: "user_message", userMessage: structuredClone(userMessage) });
    return userMessage.id;
  }

  /** Replace the newest uncommitted prompt while preserving its stable live identity. */
  replacePendingPrompt(prompt: string, attachments?: StartWorkAttachment[]): void {
    const index = this.findPendingPromptIndex(undefined, true);
    if (index < 0) {
      this.setPendingPrompt(prompt, attachments);
      return;
    }
    const current = this.userMessages[index]!;
    const next: ProjectedUserMessage = {
      ...current,
      content: prompt,
      ...(attachments?.length
        ? { attachments: structuredClone(attachments) }
        : current.attachments
          ? { attachments: current.attachments }
          : {}),
    };
    this.userMessages = this.userMessages.map((entry, entryIndex) => entryIndex === index ? next : entry);
    this.broadcast({ type: "user_message_updated", userMessage: structuredClone(next) });
  }

  /**
   * Commit the oldest matching pending prompt in FIFO order. The entry stays on the stream until
   * the client sees its `sourceEventId` in disk history, so the prompt can never flicker out.
   */
  commitPendingPrompt(expectedPrompt?: string, sourceEventId?: string, timestamp?: string): void {
    const index = this.findPendingPromptIndex(expectedPrompt, false);
    if (index < 0) return;
    const current = this.userMessages[index]!;
    const next: ProjectedUserMessage = {
      ...current,
      pending: false,
      ...(sourceEventId ? { sourceEventId } : {}),
      ...(timestamp ? { timestamp } : {}),
    };
    this.userMessages = this.userMessages.map((entry, entryIndex) => entryIndex === index ? next : entry);
    this.broadcast({
      type: "user_message_committed",
      id: next.id,
      pending: false,
      sourceEventId,
      timestamp,
    });
    if (sourceEventId) this.advanceHistory();
  }

  /** Remove the newest matching pending prompt when delivery fails. */
  discardPendingPrompt(expectedPrompt?: string): void {
    const index = this.findPendingPromptIndex(expectedPrompt, true);
    if (index < 0) return;
    const removed = this.userMessages[index];
    if (!removed) return;
    this.userMessages = this.userMessages.filter((_, entryIndex) => entryIndex !== index);
    this.broadcast({ type: "user_message_discarded", id: removed.id });
  }

  setContextSummary(summary: SessionContextSummary | null): void {
    this.contextSummary = summary;
  }

  emitUserInputRequested(request: PendingUserInputRequestView, timestamp?: string): void {
    const requestedAt = request.requestedAt ?? timestamp;
    this.pendingUserInputIndex.set(request.requestId, {
      ...structuredClone(request),
      allowFreeform: request.allowFreeform ?? true,
      ...(requestedAt ? { requestedAt } : {}),
    });
    this.emit({
      type: "user_input_requested",
      ...request,
      allowFreeform: request.allowFreeform ?? true,
      requestedAt: request.requestedAt ?? timestamp,
      timestamp,
    });
  }

  emitUserInputAnswered(
    requestId: UserInputRequestId,
    response: NativeUserInputResponse,
    timestamp?: string,
  ): void {
    this.pendingUserInputIndex.delete(requestId);
    this.emit({
      type: "user_input_answered",
      requestId,
      ...response,
      timestamp,
    });
  }

  emitUserInputCanceled(requestId: UserInputRequestId, options: UserInputCanceledOptions = {}): void {
    this.pendingUserInputIndex.delete(requestId);
    this.emit({
      type: "user_input_canceled",
      requestId,
      reason: options.reason,
      message: options.message,
      timestamp: options.timestamp,
    });
  }

  emitElicitationRequested(request: PendingElicitationRequestView, timestamp?: string): void {
    const requestedAt = request.requestedAt ?? timestamp;
    this.pendingElicitationIndex.set(request.requestId, {
      ...structuredClone(request),
      ...(requestedAt ? { requestedAt } : {}),
    });
    this.emit({
      type: "elicitation_requested",
      ...structuredClone(request),
      requestedAt: request.requestedAt ?? timestamp,
      timestamp,
    });
  }

  emitElicitationResolved(
    requestId: ElicitationRequestId,
    action: ElicitationAction,
    timestamp?: string,
  ): void {
    this.pendingElicitationIndex.delete(requestId);
    this.emit({
      type: "elicitation_resolved",
      requestId,
      action,
      timestamp,
    });
  }

  emitElicitationCanceled(
    requestId: ElicitationRequestId,
    options: ElicitationCanceledOptions = {},
  ): void {
    this.pendingElicitationIndex.delete(requestId);
    this.emit({
      type: "elicitation_canceled",
      requestId,
      reason: options.reason,
      message: options.message,
      timestamp: options.timestamp,
    });
  }

  /**
   * The only listing of in-flight interaction requests Bridge has.
   *
   * The Copilot runtime owns the requests and remains the sole adjudicator of
   * whether an id is live or stale — every *response* still goes through it —
   * but it exposes no wire method that *enumerates* them
   * (`session.permissions.pendingRequests` answers with permission prompts
   * only). Without this index a browser reconnecting mid-`ask_user` would have
   * no way to re-render the prompt. These maps are keyed by the runtime's own
   * request ids, taken straight off its `*.requested` events and normalized
   * per event at ingest by `session-runner`.
   */
  getPendingInteractionIndex(): PendingInteractionSnapshot {
    return {
      pendingUserInputs: [...this.pendingUserInputIndex.values()]
        .map((request) => structuredClone(request)),
      pendingElicitations: [...this.pendingElicitationIndex.values()]
        .map((request) => structuredClone(request)),
    };
  }

  /**
   * Drops every cached entry. Terminal cleanup owns this: it must first capture
   * the ids it needs to cancel, since the runtime only releases a pending
   * request when something answers it.
   */
  clearPendingInteractionIndex(): void {
    this.pendingUserInputIndex.clear();
    this.pendingElicitationIndex.clear();
  }

  emit(event: StreamEvent): void {
    if (event.type === "thinking") {
      const turnId = getStreamTurnId(event) ?? `turn-${randomUUID()}`;
      const turnInstanceId = getStreamTurnInstanceId(event) ?? `turn-instance-${randomUUID()}`;
      this.startTurn();
      this.currentTurnId = turnId;
      this.currentTurnInstanceId = turnInstanceId;
      event = { ...event, turnId, turnInstanceId };
    } else if (isTurnScopedStreamEvent(event)) {
      const turnId = getStreamTurnId(event) ?? this.currentTurnId;
      const turnInstanceId = getStreamTurnInstanceId(event) ?? this.currentTurnInstanceId;
      if (turnId || turnInstanceId) {
        event = {
          ...event,
          ...(turnId ? { turnId } : {}),
          ...(turnInstanceId ? { turnInstanceId } : {}),
        };
      }
    }
    if (isTerminalStreamEvent(event)) {
      this.finalizePendingUserMessages();
    }

    // Update ephemeral run state. Anything that will land in events.jsonl is announced via
    // `history_advanced` instead of being projected into a parallel transcript.
    switch (event.type) {
      case "delta":
        this.streamingContent += event.content ?? "";
        break;
      case "intent":
        this.intentText = event.intent ?? "";
        break;
      case "tool_start":
        {
          const tool = buildLiveTool(event);
          this.liveTools = upsertLiveTool(this.liveTools, tool);
          const pending = extractTerminalCompletionFromToolCall(event.name, event.args);
          if (pending) this.pendingTerminalCompletion = pending;
        }
        break;
      case "tool_update":
        // Update an existing active tool's metadata (e.g., when subagent.started upgrades a "task" tool)
        {
          const toolCallId = getToolCallId(event);
          const patch: Partial<LiveTool> = {
            name: event.name,
            turnId: getStreamTurnId(event),
            turnInstanceId: getStreamTurnInstanceId(event),
            sourceEventId: typeof event.sourceEventId === "string" ? event.sourceEventId : undefined,
            args: event.args,
            parentToolCallId: event.parentToolCallId as string | undefined,
            isSubAgent: event.isSubAgent as boolean | undefined,
            agentInstructions: event.agentInstructions as AgentInstruction[] | undefined,
            completedAt: event.completedAt as string | undefined,
            success: event.success as boolean | undefined,
            result: event.result,
          };
          this.liveTools = this.liveTools.some((tool) => tool.toolCallId === toolCallId)
            ? patchLiveTools(this.liveTools, toolCallId, patch)
            : upsertLiveTool(this.liveTools, { ...buildLiveTool(event), ...patch });
        }
        break;
      case "tool_progress":
        this.liveTools = patchLiveTools(this.liveTools, getToolCallId(event), {
          name: event.name,
          turnId: getStreamTurnId(event),
          turnInstanceId: getStreamTurnInstanceId(event),
          args: event.args,
          progressText: event.message as string | undefined,
          parentToolCallId: event.parentToolCallId as string | undefined,
          isSubAgent: event.isSubAgent as boolean | undefined,
          agentInstructions: event.agentInstructions as AgentInstruction[] | undefined,
        });
        break;
      case "tool_output":
        this.liveTools = patchLiveTools(this.liveTools, getToolCallId(event), {
          name: event.name,
          turnId: getStreamTurnId(event),
          turnInstanceId: getStreamTurnInstanceId(event),
          args: event.args,
          progressText: event.content as string | undefined,
          parentToolCallId: event.parentToolCallId as string | undefined,
          isSubAgent: event.isSubAgent as boolean | undefined,
          agentInstructions: event.agentInstructions as AgentInstruction[] | undefined,
        });
        break;
      case "tool_done":
        {
          const toolCallId = getToolCallId(event);
          const patch: Partial<LiveTool> = {
            name: event.name,
            turnId: getStreamTurnId(event),
            turnInstanceId: getStreamTurnInstanceId(event),
            parentToolCallId: event.parentToolCallId as string | undefined,
            isSubAgent: event.isSubAgent as boolean | undefined,
            agentInstructions: event.agentInstructions as AgentInstruction[] | undefined,
            completedAt: (event.timestamp as string | undefined) ?? new Date().toISOString(),
            success: event.success as boolean | undefined,
            result: event.result,
          };
          this.liveTools = this.liveTools.some((tool) => tool.toolCallId === toolCallId)
            ? patchLiveTools(this.liveTools, toolCallId, patch)
            : upsertLiveTool(this.liveTools, { ...buildLiveTool(event), ...patch });
        }
        break;
      case "assistant_partial":
        {
          const eventContent = typeof event.content === "string" ? event.content : "";
          // The SDK only persists an assistant entry when the message carries content, so an
          // empty message (a tool-only turn) must not stamp streamed text with its event id —
          // that id would never appear on disk and the segment could never retire. Leave the text
          // accumulating so the next real assistant message finalizes it.
          if (!eventContent && this.streamingContent) break;
          const content = eventContent || this.streamingContent;
          if (content) {
            const sourceEventId = typeof event.sourceEventId === "string"
              ? event.sourceEventId
              : undefined;
            const bridgeNative = event.bridgeNative === true;
            const id = sourceEventId ?? `assistant-${randomUUID()}`;
            const prior = this.liveAssistantSegments[this.liveAssistantSegments.length - 1];
            if (!prior || prior.id !== id) {
              const segment: LiveAssistantSegment = {
                id,
                content,
                ...(sourceEventId ? { sourceEventId } : {}),
                ...(bridgeNative ? { bridgeNative: true } : {}),
                ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
                ...(this.currentTurnInstanceId
                  ? { turnInstanceId: this.currentTurnInstanceId }
                  : {}),
                ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
              };
              this.liveAssistantSegments = [...this.liveAssistantSegments, segment];
              this.lastAssistantSegment = segment;
            }
          }
        }
        this.streamingContent = "";
        break;
      case "visual_published": {
        if (typeof event.artifactId !== "string") break;
        const visual: LiveVisual = {
          artifactId: event.artifactId,
          ...(typeof event.kind === "string" ? { kind: event.kind } : {}),
          ...(typeof event.title === "string" ? { title: event.title } : {}),
          ...(typeof event.displayName === "string" ? { displayName: event.displayName } : {}),
          ...(typeof event.mimeType === "string" ? { mimeType: event.mimeType } : {}),
          ...(typeof event.size === "number" ? { size: event.size } : {}),
          ...(typeof event.url === "string" ? { url: event.url } : {}),
          ...(typeof event.downloadUrl === "string" ? { downloadUrl: event.downloadUrl } : {}),
          ...(typeof event.source === "string" ? { source: event.source } : {}),
          ...(typeof event.caption === "string" ? { caption: event.caption } : {}),
          ...(typeof event.altText === "string" ? { altText: event.altText } : {}),
          ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
          ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          ...(this.currentTurnInstanceId ? { turnInstanceId: this.currentTurnInstanceId } : {}),
        };
        this.liveVisuals = [
          ...this.liveVisuals.filter((candidate) => candidate.artifactId !== visual.artifactId),
          visual,
        ];
        break;
      }
      case "mcp_status":
        this.mcpServers = (event.servers as unknown[]) ?? [];
        break;
      case "context_update":
        this.contextSummary = event.summary ?? null;
        break;
    }

    if (isTerminalStreamEvent(event)) {
      const resolved = (event.terminalCompletion as TerminalCompletion | undefined)
        ?? this.pendingTerminalCompletion;
      if (resolved && event.terminalCompletion !== resolved) {
        event = { ...event, terminalCompletion: resolved };
      }
      const terminalType = event.type as "done" | "error" | "aborted" | "shutdown";
      this.terminalTurnId = getStreamTurnId(event);
      this.terminalTurnInstanceId = getStreamTurnInstanceId(event);
      this.terminalType = terminalType;
      this.terminalTimestamp = event.timestamp as string | undefined;
      this.terminalEventId = typeof event.sourceEventId === "string" ? event.sourceEventId : undefined;
      this.terminalAssistantEventId = terminalType === "error"
        ? undefined
        : typeof event.assistantSourceEventId === "string"
          ? event.assistantSourceEventId
          : undefined;
      this.finalContent = terminalType === "error" ? undefined : event.content;
      this.errorMessage = terminalType === "error" ? event.message : undefined;
      this.terminalCompletion = resolved;
      this.pendingTerminalCompletion = undefined;
      this._complete = true;
      this.streamingContent = "";
      this.intentText = "";
      // Tools still open at the terminal never got a result; mark them finished rather than
      // dropping them, so they don't render as perpetually running before the next disk read.
      this.liveTools = this.liveTools.map((tool) => tool.completedAt
        ? tool
        : {
            ...tool,
            completedAt: this.terminalTimestamp ?? new Date().toISOString(),
            success: terminalType === "done",
          });
      if (resolved) {
        this.liveCompletion = {
          completion: resolved,
          ...(this.terminalEventId ? { sourceEventId: this.terminalEventId } : {}),
          ...(this.terminalTimestamp ? { timestamp: this.terminalTimestamp } : {}),
          ...(this.terminalTurnId ? { turnId: this.terminalTurnId } : {}),
          ...(this.terminalTurnInstanceId ? { turnInstanceId: this.terminalTurnInstanceId } : {}),
        };
      }
      this.currentTurnId = undefined;
      this.currentTurnInstanceId = undefined;
      this.runNotice = createRunNotice({
        terminalType,
        ...(this.terminalEventId ? { terminalSourceEventId: this.terminalEventId } : {}),
        ...(this.terminalAssistantEventId
          ? { assistantSourceEventId: this.terminalAssistantEventId }
          : {}),
        ...(this.finalContent ? { content: this.finalContent } : {}),
        ...(this.errorMessage ? { message: this.errorMessage } : {}),
        ...(this.terminalTimestamp ? { timestamp: this.terminalTimestamp } : {}),
        ...(this.terminalCompletion ? { terminalCompletion: this.terminalCompletion } : {}),
      });
      if (this.runNotice) event = { ...event, runNotice: { ...this.runNotice } };
      if (this.liveCompletion) event = { ...event, liveCompletion: { ...this.liveCompletion } };
      this.scheduleCleanup();
    }

    this.broadcast(event);
    if (isCommittedHistoryEvent(event)) this.advanceHistory();
  }

  private broadcast(event: StreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* don't let one listener break others */ }
    }
  }

  getSnapshot(pendingInteractions?: PendingInteractionSnapshot): BusSnapshot {
    const turnId = this.currentTurnId ?? this.terminalTurnId;
    const turnInstanceId = this.currentTurnInstanceId ?? this.terminalTurnInstanceId;
    // A completed run has nothing in flight by definition, so never replay the
    // listing index past terminal even if cancellation could not drain it.
    const pending = pendingInteractions
      ?? (this._complete
        ? { pendingUserInputs: [], pendingElicitations: [] }
        : this.getPendingInteractionIndex());
    return {
      type: "snapshot",
      runId: this.runId,
      complete: this._complete,
      streamingContent: this.streamingContent,
      liveAssistantSegments: this.liveAssistantSegments.map((segment) => ({ ...segment })),
      pendingUserMessages: this.userMessages.map((message) => structuredClone(message)),
      liveTools: this.liveTools.map((tool) => ({ ...tool })),
      liveVisuals: this.liveVisuals.map((visual) => ({ ...visual })),
      ...(this.liveCompletion ? { liveCompletion: { ...this.liveCompletion } } : {}),
      intentText: this.intentText,
      mcpServers: [...this.mcpServers],
      contextSummary: this.contextSummary,
      pendingUserInputs: pending.pendingUserInputs.map((request) => structuredClone(request)),
      pendingElicitations: pending.pendingElicitations.map((request) => structuredClone(request)),
      ...(this.runNotice ? { runNotice: { ...this.runNotice } } : {}),
      ...(this.terminalType ? { terminalType: this.terminalType } : {}),
      ...(this.terminalTimestamp ? { terminalTimestamp: this.terminalTimestamp } : {}),
      ...(turnId ? { turnId } : {}),
      ...(turnInstanceId ? { turnInstanceId } : {}),
    };
  }

  // Send snapshot then subscribe for live events
  subscribe(listener: Listener): () => void {
    // Send current snapshot as a single catch-up event
    try {
      listener(this.getSnapshot());
    } catch { /* skip */ }

    // If already complete, no need to subscribe for live events
    if (this._complete) return () => {};

    this.listeners.add(listener);
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeWithSnapshot(listener: Listener): { snapshot: BusSnapshot; unsubscribe: () => void } {
    if (!this._complete) {
      this.listeners.add(listener);
      if (this.cleanupTimer) {
        clearTimeout(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }
    return {
      snapshot: this.getSnapshot(),
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  get complete(): boolean {
    return this._complete;
  }

  /** Reset ephemeral state for a new turn (defense-in-depth) */
  reset(): void {
    this.runId = randomUUID();
    this.resetLiveTurnState();
    this.clearPendingInteractionIndex();
    this.userMessages = [];
    this.liveAssistantSegments = [];
    this.lastAssistantSegment = undefined;
  }

  private resetLiveTurnState(): void {
    this._complete = false;
    this.streamingContent = "";
    this.liveTools = [];
    this.liveVisuals = [];
    this.liveCompletion = undefined;
    this.intentText = "";
    this.terminalType = undefined;
    this.terminalTimestamp = undefined;
    this.terminalEventId = undefined;
    this.terminalAssistantEventId = undefined;
    this.runNotice = undefined;
    this.finalContent = undefined;
    this.terminalCompletion = undefined;
    this.pendingTerminalCompletion = undefined;
    this.errorMessage = undefined;
    this.currentTurnId = undefined;
    this.terminalTurnId = undefined;
    this.currentTurnInstanceId = undefined;
    this.terminalTurnInstanceId = undefined;
    this.cancelCleanup();
  }

  private startTurn(): void {
    // A new turn proves the previous turn's assistant messages reached disk, so disk-backed
    // segments can be dropped. Bridge-native segments have no disk copy and must survive.
    this.liveAssistantSegments = this.liveAssistantSegments.filter(
      (segment) => segment.bridgeNative === true,
    );
    this.resetLiveTurnState();
  }

  private findPendingPromptIndex(expectedPrompt: string | undefined, reverse: boolean): number {
    if (reverse) {
      for (let index = this.userMessages.length - 1; index >= 0; index -= 1) {
        const message = this.userMessages[index]!;
        if (message.pending && (expectedPrompt === undefined || message.content === expectedPrompt)) return index;
      }
      return -1;
    }
    return this.userMessages.findIndex((message) => (
      message.pending && (expectedPrompt === undefined || message.content === expectedPrompt)
    ));
  }

  private finalizePendingUserMessages(): void {
    this.userMessages = this.userMessages.map((message) => (
      message.pending ? { ...message, pending: false } : message
    ));
  }

  cancelCleanup(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  dispose(): void {
    this.cancelCleanup();
    this.clearPendingInteractionIndex();
    const event: StreamEvent = { type: "resync_required" };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* don't let one listener break disposal */ }
    }
    this.listeners.clear();
    this.onCleanup?.(this.sessionId);
  }

  private scheduleCleanup(): void {
    this.cleanupTimer = setTimeout(() => {
      this.onCleanup?.(this.sessionId);
    }, CLEANUP_DELAY);
  }

}

// ── Factory ───────────────────────────────────────────────────────

export function createEventBusRegistry() {
  const eventBusMap = new Map<string, SessionEventBus>();

  function getOrCreateBus(sessionId: string): SessionEventBus {
    let bus = eventBusMap.get(sessionId);
    if (!bus || bus.complete) {
      if (bus) bus.cancelCleanup();
      bus = new SessionEventBus(sessionId, (id) => eventBusMap.delete(id));
      eventBusMap.set(sessionId, bus);
    }
    return bus;
  }

  function getBus(sessionId: string): SessionEventBus | undefined {
    return eventBusMap.get(sessionId);
  }

  function hasBus(sessionId: string): boolean {
    return eventBusMap.has(sessionId);
  }

  function deleteBus(sessionId: string): void {
    eventBusMap.get(sessionId)?.dispose();
    eventBusMap.delete(sessionId);
  }

  return { getOrCreateBus, getBus, hasBus, deleteBus };
}

export type EventBusRegistry = ReturnType<typeof createEventBusRegistry>;
