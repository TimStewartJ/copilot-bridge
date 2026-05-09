import { randomUUID } from "node:crypto";

// Event bus for session streaming — decouples work from HTTP responses
// Tracks snapshot of current in-flight turn, streams live events to subscribers

import type {
  NativeUserInputResponse,
  PendingUserInputRequestView,
  UserInputCancelReason,
  UserInputRequestId,
} from "./user-input-types.js";

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

export interface StreamEvent {
  type: string;
  content?: string;
  name?: string;
  message?: string;
  intent?: string;
  turnId?: string;
  [key: string]: unknown;
}

export interface ActiveTool {
  toolCallId: string;
  name: string;
  turnId?: string;
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
  accumulatedContent: string;
  activeTools: ActiveTool[];
  currentTurnTools: CurrentTurnTool[];
  intentText: string;
  complete: boolean;
  terminalType?: "done" | "error" | "aborted" | "shutdown";
  terminalTimestamp?: string;
  finalContent?: string;
  errorMessage?: string;
  turnId?: string;
  /** The user prompt that initiated this turn (for reconnect recovery) */
  pendingPrompt?: string;
  /** Pending native user input requests only; answered/canceled requests are omitted. */
  pendingUserInputs: PendingUserInputRequestView[];
  [key: string]: unknown;
}

type Listener = (event: StreamEvent) => void;

const CLEANUP_DELAY = 60_000; // 60s after done before clearing

interface UserInputCanceledOptions {
  reason?: UserInputCancelReason;
  message?: string;
  timestamp?: string;
}

function getStreamTurnId(event: StreamEvent): string | undefined {
  return typeof event.turnId === "string" && event.turnId ? event.turnId : undefined;
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
  return {
    toolCallId: getToolCallId(event),
    name: event.name ?? "unknown",
    ...(turnId ? { turnId } : {}),
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
  private accumulatedContent = "";
  private activeTools: ActiveTool[] = [];
  private currentTurnTools: CurrentTurnTool[] = [];
  private intentText = "";
  private finalContent?: string;
  private errorMessage?: string;
  private terminalType?: "done" | "error" | "aborted" | "shutdown";
  private terminalTimestamp?: string;
  private mcpServers: unknown[] = [];
  private currentTurnId?: string;
  private terminalTurnId?: string;
  /** The user prompt that initiated this turn (for reconnect recovery) */
  private pendingPrompt?: string;
  private pendingUserInputs = new Map<UserInputRequestId, PendingUserInputRequestView>();

  constructor(
    private sessionId: string,
    private onCleanup?: (sessionId: string) => void,
  ) {}

  getIntentText(): string {
    return this.intentText;
  }

  /** Store the user prompt so late-connecting clients can recover it */
  setPendingPrompt(prompt: string): void {
    this.pendingPrompt = prompt;
  }

  /** Stop advertising reconnect recovery once the prompt is durably persisted */
  clearPendingPrompt(): void {
    this.pendingPrompt = undefined;
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

  emit(event: StreamEvent): void {
    if (event.type === "thinking") {
      const turnId = getStreamTurnId(event) ?? `turn-${randomUUID()}`;
      this.currentTurnId = turnId;
      this.terminalTurnId = undefined;
      event = { ...event, turnId };
    } else if (this.currentTurnId && isTurnScopedStreamEvent(event) && !getStreamTurnId(event)) {
      event = { ...event, turnId: this.currentTurnId };
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
          this.activeTools = upsertActiveTool(this.activeTools, tool);
          this.currentTurnTools = upsertCurrentTurnTool(this.currentTurnTools, tool);
        }
        break;
      case "tool_update":
        // Update an existing active tool's metadata (e.g., when subagent.started upgrades a "task" tool)
        {
          const toolCallId = getToolCallId(event);
          const patch: Partial<ActiveTool> = {
            name: event.name,
            turnId: getStreamTurnId(event),
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
        // Intermediate message boundary — reset content accumulator
        this.accumulatedContent = "";
        break;
      case "user_input_requested": {
        const pending = this.pendingUserInputFromEvent(event);
        if (pending) {
          this.pendingUserInputs.set(pending.requestId, pending);
        }
        break;
      }
      case "user_input_answered":
      case "user_input_canceled": {
        const requestId = this.userInputRequestIdFromEvent(event);
        if (requestId) {
          this.pendingUserInputs.delete(requestId);
        }
        break;
      }
      case "done":
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalType = "done";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.finalContent = event.content;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.pendingUserInputs.clear();
        this.currentTurnTools = [];
        this.currentTurnId = undefined;
        this.scheduleCleanup();
        break;
      case "aborted":
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalType = "aborted";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.finalContent = event.content;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.pendingUserInputs.clear();
        this.currentTurnTools = [];
        this.currentTurnId = undefined;
        this.scheduleCleanup();
        break;
      case "shutdown":
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalType = "shutdown";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.finalContent = event.content;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.pendingUserInputs.clear();
        this.currentTurnTools = [];
        this.currentTurnId = undefined;
        this.scheduleCleanup();
        break;
      case "error":
        this.terminalTurnId = getStreamTurnId(event);
        this.terminalType = "error";
        this.terminalTimestamp = event.timestamp as string | undefined;
        this.errorMessage = event.message;
        this._complete = true;
        this.accumulatedContent = "";
        this.intentText = "";
        this.activeTools = [];
        this.pendingUserInputs.clear();
        this.currentTurnTools = [];
        this.currentTurnId = undefined;
        this.scheduleCleanup();
        break;
      case "mcp_status":
        this.mcpServers = (event.servers as unknown[]) ?? [];
        break;
    }

    // Broadcast to live listeners
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* don't let one listener break others */ }
    }
  }

  getSnapshot(): BusSnapshot {
    const turnId = this.currentTurnId ?? this.terminalTurnId;
    return {
      type: "snapshot",
      accumulatedContent: this.accumulatedContent,
      activeTools: [...this.activeTools],
      currentTurnTools: [...this.currentTurnTools],
      intentText: this.intentText,
      complete: this._complete,
      terminalType: this.terminalType,
      terminalTimestamp: this.terminalTimestamp,
      finalContent: this.finalContent,
      errorMessage: this.errorMessage,
      mcpServers: [...this.mcpServers],
      pendingPrompt: this.pendingPrompt,
      pendingUserInputs: [...this.pendingUserInputs.values()],
      ...(turnId ? { turnId } : {}),
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

  get complete(): boolean {
    return this._complete;
  }

  /** Reset snapshot state for a new turn (defense-in-depth) */
  reset(): void {
    this._complete = false;
    this.accumulatedContent = "";
    this.activeTools = [];
    this.currentTurnTools = [];
    this.intentText = "";
    this.terminalType = undefined;
    this.terminalTimestamp = undefined;
    this.finalContent = undefined;
    this.errorMessage = undefined;
    this.currentTurnId = undefined;
    this.terminalTurnId = undefined;
    this.pendingPrompt = undefined;
    this.pendingUserInputs.clear();
    this.cancelCleanup();
  }

  cancelCleanup(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private scheduleCleanup(): void {
    this.cleanupTimer = setTimeout(() => {
      this.onCleanup?.(this.sessionId);
    }, CLEANUP_DELAY);
  }

  private pendingUserInputFromEvent(event: StreamEvent): PendingUserInputRequestView | undefined {
    const requestId = this.userInputRequestIdFromEvent(event);
    if (!requestId || typeof event.question !== "string") {
      return undefined;
    }

    const choices = Array.isArray(event.choices)
      ? event.choices.filter((choice): choice is string => typeof choice === "string")
      : undefined;
    const requestedAt = typeof event.requestedAt === "string"
      ? event.requestedAt
      : typeof event.timestamp === "string"
        ? event.timestamp
        : undefined;

    return {
      requestId,
      question: event.question,
      choices,
      allowFreeform: typeof event.allowFreeform === "boolean" ? event.allowFreeform : true,
      requestedAt,
      toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    };
  }

  private userInputRequestIdFromEvent(event: StreamEvent): UserInputRequestId | undefined {
    return typeof event.requestId === "string" ? event.requestId : undefined;
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

  return { getOrCreateBus, getBus, hasBus };
}

export type EventBusRegistry = ReturnType<typeof createEventBusRegistry>;

// ── Default instance (backward compat) ────────────────────────────

const _default = createEventBusRegistry();
export const getOrCreateBus = _default.getOrCreateBus;
export const getBus = _default.getBus;
export const hasBus = _default.hasBus;

/** Access the default instance for passing to factories during migration */
export const defaultEventBusRegistry = _default;
