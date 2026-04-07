import { useEffect, useRef } from "react";
import { API_BASE } from "./api";

export interface StatusEvent {
  type: "session:busy" | "session:idle" | "session:title" | "session:intent"
      | "session:archived" | "server:restart-pending" | "server:restart-cleared"
      | "status:connected" | "schedule:changed" | "task:changed" | "readstate:changed";
  sessionId?: string;
  title?: string;
  intent?: string;
  archived?: boolean;
  waitingSessions?: number;
  taskId?: string;
  scheduleId?: string;
  readState?: Record<string, string>;
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
    const es = new EventSource(`${API_BASE}/api/status-stream`);

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
