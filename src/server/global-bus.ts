// Global event bus for cross-session status changes
// Pushes busy/idle/title/intent events to all connected SSE clients

export interface StatusEvent {
  type: "session:busy" | "session:idle" | "session:title" | "session:intent" | "session:archived" | "server:restart-pending" | "server:restart-cleared" | "schedule:triggered" | "schedule:changed" | "task:changed" | "readstate:changed";
  sessionId?: string;
  title?: string;
  intent?: string;
  archived?: boolean;
  waitingSessions?: number;
  scheduleId?: string;
  scheduleName?: string;
  taskId?: string;
  readState?: Record<string, string>;
}

type Listener = (event: StatusEvent) => void;

// ── Factory ───────────────────────────────────────────────────────

export function createGlobalBus() {
  const listeners = new Set<Listener>();

  function emit(event: StatusEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch { /* don't let one listener break others */ }
    }
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { emit, subscribe };
}

export type GlobalBus = ReturnType<typeof createGlobalBus>;

// ── Default instance (backward compat) ────────────────────────────

const _default = createGlobalBus();
export const emit = _default.emit;
export const subscribe = _default.subscribe;

/** Access the default instance for passing to factories during migration */
export const defaultGlobalBus = _default;
