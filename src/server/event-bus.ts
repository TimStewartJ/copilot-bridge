// Event bus for session streaming — decouples work from HTTP responses
// Buffers events per session, supports multiple subscribers + replay

export interface StreamEvent {
  type: string;
  content?: string;
  name?: string;
  message?: string;
  intent?: string;
  [key: string]: unknown;
}

type Listener = (event: StreamEvent) => void;

const CLEANUP_DELAY = 60_000; // 60s after done before clearing buffer
const MAX_BUFFER_SIZE = 1000;

class SessionEventBus {
  private events: StreamEvent[] = [];
  private listeners = new Set<Listener>();
  private _complete = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  emit(event: StreamEvent): void {
    if (this.events.length >= MAX_BUFFER_SIZE) {
      this.events.shift(); // drop oldest
    }
    this.events.push(event);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* don't let one listener break others */ }
    }

    if (event.type === "done" || event.type === "error") {
      this._complete = true;
      this.scheduleCleanup();
    }
  }

  // Subscribe and replay all buffered events, then stream new ones
  subscribe(listener: Listener): () => void {
    // Replay history
    for (const event of this.events) {
      try {
        listener(event);
      } catch { /* skip */ }
    }

    // If already complete, no need to subscribe for live events
    if (this._complete) return () => {};

    this.listeners.add(listener);
    // Cancel cleanup if someone reconnects
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

  constructor(private sessionId: string) {}
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
