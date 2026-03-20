import { useEffect, useRef } from "react";

export interface StatusEvent {
  type: "session:busy" | "session:idle" | "session:title" | "session:intent"
      | "server:restart-pending" | "status:connected";
  sessionId?: string;
  title?: string;
  intent?: string;
  waitingSessions?: number;
}

type StatusHandler = (event: StatusEvent) => void;

/**
 * Persistent SSE connection to /api/status-stream.
 * Uses native EventSource for automatic reconnection.
 * Fires a synthetic "status:connected" event on each (re)connection
 * so consumers can clear stale state.
 */
export function useStatusStream(onEvent: StatusHandler): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const es = new EventSource("/api/status-stream");

    es.onopen = () => {
      handlerRef.current({ type: "status:connected" });
    };

    es.onmessage = (e) => {
      try {
        const event: StatusEvent = JSON.parse(e.data);
        handlerRef.current(event);
      } catch { /* skip malformed */ }
    };

    es.onerror = () => {
      // EventSource auto-reconnects — nothing to do
    };

    return () => { es.close(); };
  }, []);
}
