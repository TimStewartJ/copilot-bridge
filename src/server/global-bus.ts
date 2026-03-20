// Global event bus for cross-session status changes
// Pushes busy/idle/title/intent events to all connected SSE clients

export interface StatusEvent {
  type: "session:busy" | "session:idle" | "session:title" | "session:intent";
  sessionId: string;
  title?: string;
  intent?: string;
}

type Listener = (event: StatusEvent) => void;

const listeners = new Set<Listener>();

export function emit(event: StatusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch { /* don't let one listener break others */ }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
