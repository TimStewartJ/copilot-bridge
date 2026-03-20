import { useEffect, useRef } from "react";

export interface StatusEvent {
  type: "session:busy" | "session:idle" | "session:title" | "session:intent";
  sessionId: string;
  title?: string;
  intent?: string;
}

type StatusHandler = (event: StatusEvent) => void;

/**
 * Persistent SSE connection to /api/status-stream.
 * Uses native EventSource for automatic reconnection.
 */
export function useStatusStream(onEvent: StatusHandler): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const es = new EventSource("/api/status-stream");

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
