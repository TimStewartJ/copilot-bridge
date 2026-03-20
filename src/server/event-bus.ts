// Event bus for session streaming — decouples work from HTTP responses
// Tracks snapshot of current in-flight turn, streams live events to subscribers

export interface StreamEvent {
  type: string;
  content?: string;
  name?: string;
  message?: string;
  intent?: string;
  [key: string]: unknown;
}

export interface ActiveTool {
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface BusSnapshot {
  type: "snapshot";
  accumulatedContent: string;
  activeTools: ActiveTool[];
  intentText: string;
  complete: boolean;
  finalContent?: string;
  errorMessage?: string;
}

type Listener = (event: StreamEvent) => void;

const CLEANUP_DELAY = 60_000; // 60s after done before clearing

class SessionEventBus {
  private listeners = new Set<Listener>();
  private _complete = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  // Snapshot state — tracks the current in-flight turn
  private accumulatedContent = "";
  private activeTools: ActiveTool[] = [];
  private intentText = "";
  private finalContent?: string;
  private errorMessage?: string;

  constructor(private sessionId: string) {}

  emit(event: StreamEvent): void {
    // Update snapshot state based on event type
    switch (event.type) {
      case "delta":
        this.accumulatedContent += event.content ?? "";
        break;
      case "intent":
        this.intentText = event.intent ?? "";
        break;
      case "tool_start":
        this.activeTools.push({
          toolCallId: (event.toolCallId as string) ?? "",
          name: event.name ?? "unknown",
          args: event.args as Record<string, unknown> | undefined,
        });
        break;
      case "tool_done":
        this.activeTools = this.activeTools.filter(
          (t) => t.toolCallId !== event.toolCallId,
        );
        break;
      case "assistant_partial":
        // Intermediate message boundary — reset content accumulator
        this.accumulatedContent = "";
        break;
      case "done":
        this.finalContent = event.content;
        this._complete = true;
        this.accumulatedContent = "";
        this.activeTools = [];
        this.scheduleCleanup();
        break;
      case "error":
        this.errorMessage = event.message;
        this._complete = true;
        this.accumulatedContent = "";
        this.activeTools = [];
        this.scheduleCleanup();
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
    return {
      type: "snapshot",
      accumulatedContent: this.accumulatedContent,
      activeTools: [...this.activeTools],
      intentText: this.intentText,
      complete: this._complete,
      finalContent: this.finalContent,
      errorMessage: this.errorMessage,
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

  private scheduleCleanup(): void {
    this.cleanupTimer = setTimeout(() => {
      eventBusMap.delete(this.sessionId);
    }, CLEANUP_DELAY);
  }
}

// Global registry of active event buses
const eventBusMap = new Map<string, SessionEventBus>();

export function getOrCreateBus(sessionId: string): SessionEventBus {
  let bus = eventBusMap.get(sessionId);
  if (!bus) {
    bus = new SessionEventBus(sessionId);
    eventBusMap.set(sessionId, bus);
  }
  return bus;
}

export function getBus(sessionId: string): SessionEventBus | undefined {
  return eventBusMap.get(sessionId);
}

export function hasBus(sessionId: string): boolean {
  return eventBusMap.has(sessionId);
}
