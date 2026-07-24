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
import {
  extractTerminalCompletionFromToolCall,
  type TerminalCompletion,
} from "../shared/terminal-completion.js";
import type { ProjectedAssistantEntry } from "../shared/session-stream.js";
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

export interface ActiveTool {
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
}

export interface CurrentTurnTool extends ActiveTool {
  completedAt?: string;
  success?: boolean;
  result?: unknown;
}

export interface BusSnapshot {
  type: "snapshot";
  runId: string;
  accumulatedContent: string;
  userMessages: ProjectedUserMessage[];
  assistantSegments: AssistantSegment[];
  activeTools: ActiveTool[];
  currentTurnTools: CurrentTurnTool[];
  visuals: PublishedVisual[];
  entryOrder: string[];
  intentText: string;
  complete: boolean;
  terminalType?: "done" | "error" | "aborted" | "shutdown";
  terminalTimestamp?: string;
  finalContent?: string;
  terminalCompletion?: TerminalCompletion;
  errorMessage?: string;
  terminalEventId?: string;
  terminalAssistantEventId?: string;
  finalAssistantEntry?: ProjectedAssistantEntry;
  turnId?: string;
  turnInstanceId?: string;
  contextSummary: SessionContextSummary | null;
  /** Pending native user input requests only; answered/canceled requests are omitted. */
  pendingUserInputs: PendingUserInputRequestView[];
  /** Pending native elicitation requests only; resolved/canceled requests are omitted. */
  pendingElicitations: PendingElicitationRequestView[];
  [key: string]: unknown;
}

export interface PendingInteractionSnapshot {
  pendingUserInputs: PendingUserInputRequestView[];
  pendingElicitations: PendingElicitationRequestView[];
}

export interface AssistantSegment {
  id: string;
  content: string;
  turnId?: string;
  turnInstanceId?: string;
  sourceEventId?: string;
  timestamp?: string;
}

export interface ProjectedUserMessage {
  id: string;
  content: string;
  attachments?: StartWorkAttachment[];
  pending: boolean;
  sourceEventId?: string;
  timestamp?: string;
}

export interface PublishedVisual {
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

export interface TerminalAssistantProjectionOptions {
  runId: string;
  terminalType: "done" | "error" | "aborted" | "shutdown";
  turnId?: string;
  turnInstanceId?: string;
  terminalSourceEventId?: string;
  assistantSourceEventId?: string;
  content?: string;
  message?: string;
  timestamp?: string;
  terminalCompletion?: TerminalCompletion;
}

export function createProjectedFinalAssistantEntry(
  options: TerminalAssistantProjectionOptions,
): ProjectedAssistantEntry | undefined {
  if (options.terminalCompletion) return undefined;
  const content = options.terminalType === "error"
    ? `⚠️ Error: ${options.message || "Unknown session error"}`
    : options.content;
  if (!content) return undefined;
  const formattedContent = options.terminalType === "aborted"
    ? `${content}\n\n*(stopped)*`
    : options.terminalType === "shutdown"
      ? `${content}\n\n*(interrupted)*`
      : content;
  const sourceEventId = options.assistantSourceEventId ?? options.terminalSourceEventId;
  return {
    id: sourceEventId ?? `terminal-${options.runId}`,
    content: formattedContent,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.turnInstanceId ? { turnInstanceId: options.turnInstanceId } : {}),
    ...(sourceEventId ? { sourceEventId } : {}),
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
  };
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

function buildActiveTool(event: StreamEvent): ActiveTool {
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
  };
}

function mergeActiveTool(existing: ActiveTool, patch: Partial<ActiveTool>): ActiveTool {
  const merged: ActiveTool = {
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
  return merged;
}

function mergeCurrentTurnTool(existing: CurrentTurnTool, patch: Partial<CurrentTurnTool>): CurrentTurnTool {
  const merged: CurrentTurnTool = mergeActiveTool(existing, patch);
  if (patch.completedAt !== undefined) merged.completedAt = patch.completedAt;
  if (patch.success !== undefined) merged.success = patch.success;
  if (patch.result !== undefined) merged.result = patch.result;
  return merged;
}

function upsertActiveTool(tools: ActiveTool[], nextTool: ActiveTool): ActiveTool[] {
  const existingIndex = tools.findIndex((tool) => tool.toolCallId === nextTool.toolCallId);
  if (existingIndex < 0) return [...tools, nextTool];
  return tools.map((tool, index) => index === existingIndex ? mergeActiveTool(tool, nextTool) : tool);
}

function upsertCurrentTurnTool(tools: CurrentTurnTool[], nextTool: CurrentTurnTool): CurrentTurnTool[] {
  const existingIndex = tools.findIndex((tool) => tool.toolCallId === nextTool.toolCallId);
  if (existingIndex < 0) return [...tools, nextTool];
  return tools.map((tool, index) => index === existingIndex ? mergeCurrentTurnTool(tool, nextTool) : tool);
}

function patchActiveTools(tools: ActiveTool[], toolCallId: string, patch: Partial<ActiveTool>): ActiveTool[] {
  return tools.map((tool) => tool.toolCallId === toolCallId ? mergeActiveTool(tool, patch) : tool);
}

function patchCurrentTurnTools(tools: CurrentTurnTool[], toolCallId: string, patch: Partial<CurrentTurnTool>): CurrentTurnTool[] {
  return tools.map((tool) => tool.toolCallId === toolCallId ? mergeCurrentTurnTool(tool, patch) : tool);
}

export class SessionEventBus {
  private listeners = new Set<Listener>();
  private _complete = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  // Snapshot state — tracks the current in-flight turn
  private runId = randomUUID();
  private accumulatedContent = "";
  private userMessages: ProjectedUserMessage[] = [];
  private assistantSegments: AssistantSegment[] = [];
  private activeTools: ActiveTool[] = [];
  private currentTurnTools: CurrentTurnTool[] = [];
  private visuals: PublishedVisual[] = [];
  private entryOrder: string[] = [];
  private intentText = "";
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
  private finalAssistantEntry?: ProjectedAssistantEntry;
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

  /** Add a server-owned user entry before the SDK persists it. */
  setPendingPrompt(prompt: string, attachments?: StartWorkAttachment[]): string {
    const userMessage: ProjectedUserMessage = {
      id: randomUUID(),
      content: prompt,
      pending: true,
      ...(attachments?.length ? { attachments: structuredClone(attachments) } : {}),
    };
    this.userMessages = [...this.userMessages, userMessage];
    this.entryOrder = [...this.entryOrder, `user:${userMessage.id}`];
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

  /** Commit the oldest matching pending prompt in FIFO order. */
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
  }

  /** Remove the newest matching pending prompt when delivery fails. */
  discardPendingPrompt(expectedPrompt?: string): void {
    const index = this.findPendingPromptIndex(expectedPrompt, true);
    if (index < 0) return;
    const removed = this.userMessages[index];
    if (!removed) return;
    this.userMessages = this.userMessages.filter((_, entryIndex) => entryIndex !== index);
    this.entryOrder = this.entryOrder.filter((key) => key !== `user:${removed.id}`);
    this.broadcast({ type: "user_message_discarded", id: removed.id });
  }

  setContextSummary(summary: SessionContextSummary | null): void {
    this.contextSummary = summary;
  }

  emitUserInputRequested(request: PendingUserInputRequestView, timestamp?: string): void {
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
    this.emit({
      type: "user_input_answered",
      requestId,
      ...response,
      timestamp,
    });
  }

  emitUserInputCanceled(requestId: UserInputRequestId, options: UserInputCanceledOptions = {}): void {
    this.emit({
      type: "user_input_canceled",
      requestId,
      reason: options.reason,
      message: options.message,
      timestamp: options.timestamp,
    });
  }

  emitElicitationRequested(request: PendingElicitationRequestView, timestamp?: string): void {
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
    this.emit({
      type: "elicitation_canceled",
      requestId,
      reason: options.reason,
      message: options.message,
      timestamp: options.timestamp,
    });
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

    // Update snapshot state based on event type
    switch (event.type) {
      case "delta":
        this.accumulatedContent += event.content ?? "";
        break;
      case "intent":
        this.intentText = event.intent ?? "";
        break;
      case "tool_start":
        {
          const tool = buildActiveTool(event);
          if (!this.currentTurnTools.some((candidate) => candidate.toolCallId === tool.toolCallId)) {
            this.entryOrder = [...this.entryOrder, `tool:${tool.toolCallId}`];
          }
          this.activeTools = upsertActiveTool(this.activeTools, tool);
          this.currentTurnTools = upsertCurrentTurnTool(this.currentTurnTools, tool);
          const pending = extractTerminalCompletionFromToolCall(event.name, event.args);
          if (pending) this.pendingTerminalCompletion = pending;
        }
        break;
      case "tool_update":
        // Update an existing active tool's metadata (e.g., when subagent.started upgrades a "task" tool)
        {
          const toolCallId = getToolCallId(event);
          const patch: Partial<ActiveTool> = {
            name: event.name,
            turnId: getStreamTurnId(event),
            turnInstanceId: getStreamTurnInstanceId(event),
            sourceEventId: typeof event.sourceEventId === "string" ? event.sourceEventId : undefined,
            args: event.args,
            parentToolCallId: event.parentToolCallId as string | undefined,
            isSubAgent: event.isSubAgent as boolean | undefined,
          };
          this.activeTools = patchActiveTools(this.activeTools, toolCallId, patch);
          this.currentTurnTools = patchCurrentTurnTools(this.currentTurnTools, toolCallId, patch);
        }
        break;
      case "tool_progress":
        {
          const toolCallId = getToolCallId(event);
          const patch: Partial<ActiveTool> = {
            name: event.name,
            turnId: getStreamTurnId(event),
            turnInstanceId: getStreamTurnInstanceId(event),
            sourceEventId: typeof event.sourceEventId === "string" ? event.sourceEventId : undefined,
            args: event.args,
            progressText: event.message as string | undefined,
            parentToolCallId: event.parentToolCallId as string | undefined,
            isSubAgent: event.isSubAgent as boolean | undefined,
          };
          this.activeTools = patchActiveTools(this.activeTools, toolCallId, patch);
          this.currentTurnTools = patchCurrentTurnTools(this.currentTurnTools, toolCallId, patch);
        }
        break;
      case "tool_output":
        {
          const toolCallId = getToolCallId(event);
          const patch: Partial<ActiveTool> = {
            name: event.name,
            turnId: getStreamTurnId(event),
            turnInstanceId: getStreamTurnInstanceId(event),
            sourceEventId: typeof event.sourceEventId === "string" ? event.sourceEventId : undefined,
            args: event.args,
            progressText: event.content as string | undefined,
            parentToolCallId: event.parentToolCallId as string | undefined,
            isSubAgent: event.isSubAgent as boolean | undefined,
          };
          this.activeTools = patchActiveTools(this.activeTools, toolCallId, patch);
          this.currentTurnTools = patchCurrentTurnTools(this.currentTurnTools, toolCallId, patch);
        }
        break;
      case "tool_done":
        {
          const toolCallId = getToolCallId(event);
          const priorTool = this.currentTurnTools.find((tool) => tool.toolCallId === toolCallId)
            ?? this.activeTools.find((tool) => tool.toolCallId === toolCallId);
          const completedTool: CurrentTurnTool = {
            toolCallId,
            name: event.name ?? priorTool?.name ?? "unknown",
            turnId: getStreamTurnId(event) ?? priorTool?.turnId,
            turnInstanceId: getStreamTurnInstanceId(event) ?? priorTool?.turnInstanceId,
            sourceEventId: typeof event.sourceEventId === "string"
              ? event.sourceEventId
              : priorTool?.sourceEventId,
            args: event.args !== undefined ? event.args : priorTool?.args,
            startedAt: priorTool?.startedAt,
            progressText: (event.message as string | undefined)
              ?? (event.content as string | undefined)
              ?? priorTool?.progressText,
            parentToolCallId: (event.parentToolCallId as string | undefined) ?? priorTool?.parentToolCallId,
            isSubAgent: (event.isSubAgent as boolean | undefined) ?? priorTool?.isSubAgent,
            completedAt: event.timestamp as string | undefined,
            success: event.success as boolean | undefined,
            result: event.result,
          };
          this.activeTools = this.activeTools.filter(
            (t) => t.toolCallId !== toolCallId,
          );
          this.currentTurnTools = upsertCurrentTurnTool(this.currentTurnTools, completedTool);
        }
        break;
      case "assistant_partial":
        {
          const content = typeof event.content === "string" && event.content
            ? event.content
            : this.accumulatedContent;
          if (content) {
            const sourceEventId = typeof event.sourceEventId === "string"
              ? event.sourceEventId
              : undefined;
            const id = sourceEventId ?? `assistant-${randomUUID()}`;
            const prior = this.assistantSegments[this.assistantSegments.length - 1];
            if (!prior || prior.id !== id) {
              this.entryOrder = [...this.entryOrder, `assistant:${id}`];
              this.assistantSegments = [
                ...this.assistantSegments,
                {
                  id,
                  content,
                  ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
                  ...(this.currentTurnInstanceId
                    ? { turnInstanceId: this.currentTurnInstanceId }
                    : {}),
                  ...(sourceEventId ? { sourceEventId } : {}),
                  ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
                },
              ];
            }
          }
        }
        this.accumulatedContent = "";
        break;
      case "visual_published": {
        if (typeof event.artifactId !== "string") break;
        const visual: PublishedVisual = {
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
          ...(this.currentTurnInstanceId
            ? { turnInstanceId: this.currentTurnInstanceId }
            : {}),
        };
        this.visuals = [
          ...this.visuals.filter((candidate) => candidate.artifactId !== visual.artifactId),
          visual,
        ];
        if (!this.entryOrder.includes(`visual:${visual.artifactId}`)) {
          this.entryOrder = [...this.entryOrder, `visual:${visual.artifactId}`];
        }
        break;
      }
      case "done": {
        const resolved = (event.terminalCompletion as TerminalCompletion | undefined)
          ?? this.pendingTerminalCompletion;
        if (resolved && event.terminalCompletion !== resolved) {
          event = { ...event, terminalCompletion: resolved };
        }
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalTurnInstanceId = getStreamTurnInstanceId(event);
        this.terminalType = "done";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.terminalEventId = typeof event.sourceEventId === "string" ? event.sourceEventId : undefined;
        this.terminalAssistantEventId = typeof event.assistantSourceEventId === "string"
          ? event.assistantSourceEventId
          : undefined;
        this.finalContent = event.content;
        this.terminalCompletion = resolved;
        this.pendingTerminalCompletion = undefined;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.currentTurnId = undefined;
        this.currentTurnInstanceId = undefined;
        this.scheduleCleanup();
        break;
      }
      case "aborted": {
        const resolved = (event.terminalCompletion as TerminalCompletion | undefined)
          ?? this.pendingTerminalCompletion;
        if (resolved && event.terminalCompletion !== resolved) {
          event = { ...event, terminalCompletion: resolved };
        }
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalTurnInstanceId = getStreamTurnInstanceId(event);
        this.terminalType = "aborted";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.terminalEventId = typeof event.sourceEventId === "string" ? event.sourceEventId : undefined;
        this.terminalAssistantEventId = typeof event.assistantSourceEventId === "string"
          ? event.assistantSourceEventId
          : undefined;
        this.finalContent = event.content;
        this.terminalCompletion = resolved;
        this.pendingTerminalCompletion = undefined;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.currentTurnId = undefined;
        this.currentTurnInstanceId = undefined;
        this.scheduleCleanup();
        break;
      }
      case "shutdown": {
        const resolved = (event.terminalCompletion as TerminalCompletion | undefined)
          ?? this.pendingTerminalCompletion;
        if (resolved && event.terminalCompletion !== resolved) {
          event = { ...event, terminalCompletion: resolved };
        }
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalTurnInstanceId = getStreamTurnInstanceId(event);
        this.terminalType = "shutdown";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.terminalEventId = typeof event.sourceEventId === "string" ? event.sourceEventId : undefined;
        this.terminalAssistantEventId = typeof event.assistantSourceEventId === "string"
          ? event.assistantSourceEventId
          : undefined;
        this.finalContent = event.content;
        this.terminalCompletion = resolved;
        this.pendingTerminalCompletion = undefined;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.currentTurnId = undefined;
        this.currentTurnInstanceId = undefined;
        this.scheduleCleanup();
        break;
      }
      case "error": {
        const resolved = (event.terminalCompletion as TerminalCompletion | undefined)
          ?? this.pendingTerminalCompletion;
        if (resolved && event.terminalCompletion !== resolved) {
          event = { ...event, terminalCompletion: resolved };
        }
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalTurnInstanceId = getStreamTurnInstanceId(event);
        this.terminalType = "error";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.terminalEventId = typeof event.sourceEventId === "string" ? event.sourceEventId : undefined;
        this.terminalAssistantEventId = undefined;
        this.errorMessage = event.message;
        this.terminalCompletion = resolved;
        this.pendingTerminalCompletion = undefined;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.currentTurnId = undefined;
        this.currentTurnInstanceId = undefined;
        this.scheduleCleanup();
        break;
      }
      case "mcp_status":
        this.mcpServers = (event.servers as unknown[]) ?? [];
        break;
      case "context_update":
        this.contextSummary = event.summary ?? null;
        break;
    }

    if (isTerminalStreamEvent(event) && this.terminalType) {
      this.finalAssistantEntry = createProjectedFinalAssistantEntry({
        runId: this.runId,
        terminalType: this.terminalType,
        ...(this.terminalTurnId ? { turnId: this.terminalTurnId } : {}),
        ...(this.terminalTurnInstanceId
          ? { turnInstanceId: this.terminalTurnInstanceId }
          : {}),
        ...(this.terminalEventId ? { terminalSourceEventId: this.terminalEventId } : {}),
        ...(this.terminalAssistantEventId
          ? { assistantSourceEventId: this.terminalAssistantEventId }
          : {}),
        ...(this.finalContent ? { content: this.finalContent } : {}),
        ...(this.errorMessage ? { message: this.errorMessage } : {}),
        ...(this.terminalTimestamp ? { timestamp: this.terminalTimestamp } : {}),
        ...(this.terminalCompletion ? { terminalCompletion: this.terminalCompletion } : {}),
      });
      if (this.finalAssistantEntry) {
        event = { ...event, finalAssistantEntry: { ...this.finalAssistantEntry } };
      }
    }

    this.broadcast(event);
  }

  private broadcast(event: StreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* don't let one listener break others */ }
    }
  }

  getSnapshot(pendingInteractions: PendingInteractionSnapshot = {
    pendingUserInputs: [],
    pendingElicitations: [],
  }): BusSnapshot {
    const turnId = this.currentTurnId ?? this.terminalTurnId;
    const turnInstanceId = this.currentTurnInstanceId ?? this.terminalTurnInstanceId;
    return {
      type: "snapshot",
      runId: this.runId,
      accumulatedContent: this.accumulatedContent,
      userMessages: this.userMessages.map((message) => structuredClone(message)),
      assistantSegments: this.assistantSegments.map((segment) => ({ ...segment })),
      activeTools: [...this.activeTools],
      currentTurnTools: [...this.currentTurnTools],
      visuals: this.visuals.map((visual) => ({ ...visual })),
      entryOrder: [...this.entryOrder],
      intentText: this.intentText,
      complete: this._complete,
      terminalType: this.terminalType,
      terminalTimestamp: this.terminalTimestamp,
      finalContent: this.finalContent,
      terminalCompletion: this.terminalCompletion,
      errorMessage: this.errorMessage,
      terminalEventId: this.terminalEventId,
      terminalAssistantEventId: this.terminalAssistantEventId,
      finalAssistantEntry: this.finalAssistantEntry
        ? { ...this.finalAssistantEntry }
        : undefined,
      mcpServers: [...this.mcpServers],
      contextSummary: this.contextSummary,
      pendingUserInputs: pendingInteractions.pendingUserInputs.map((request) => structuredClone(request)),
      pendingElicitations: pendingInteractions.pendingElicitations.map((request) => structuredClone(request)),
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

  /** Reset snapshot state for a new turn (defense-in-depth) */
  reset(): void {
    this.runId = randomUUID();
    this.resetLiveTurnState();
    this.userMessages = [];
    this.assistantSegments = [];
    this.visuals = [];
    this.entryOrder = [];
  }

  private resetLiveTurnState(): void {
    this._complete = false;
    this.accumulatedContent = "";
    this.activeTools = [];
    this.currentTurnTools = [];
    this.intentText = "";
    this.terminalType = undefined;
    this.terminalTimestamp = undefined;
    this.terminalEventId = undefined;
    this.terminalAssistantEventId = undefined;
    this.finalAssistantEntry = undefined;
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
    this._complete = false;
    this.accumulatedContent = "";
    this.activeTools = [];
    this.intentText = "";
    this.terminalType = undefined;
    this.terminalTimestamp = undefined;
    this.terminalEventId = undefined;
    this.terminalAssistantEventId = undefined;
    this.finalAssistantEntry = undefined;
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

// ── Default instance (backward compat) ────────────────────────────

const _default = createEventBusRegistry();
export const getOrCreateBus = _default.getOrCreateBus;
export const getBus = _default.getBus;
export const hasBus = _default.hasBus;

/** Access the default instance for passing to factories during migration */
export const defaultEventBusRegistry = _default;
