import { useEffect, useRef } from "react";
import { API_BASE } from "./api";
import type { DeferSummary, RestartStatusPhase } from "./api";
import type { ManagementJobStatus, ManagementJobType } from "./management-job-api";

export type StatusEvent =
  | { type: "session:busy" | "session:stalled" | "session:idle"; sessionId?: string }
  | { type: "session:title"; sessionId?: string; title?: string }
  | { type: "session:intent"; sessionId?: string; intent?: string }
  | { type: "session:archived"; sessionId?: string; archived?: boolean }
  | { type: "sessions:changed" }
  | {
      type: "session:user-input";
      sessionId?: string;
      pendingUserInputCount?: number;
      needsUserInput?: boolean;
    }
  | { type: "session:defer-summary"; sessionId: string; deferSummary: DeferSummary }
  | { type: "session:history-truncated"; sessionId?: string }
  | {
      type: "server:restart-pending";
      waitingSessions?: number;
      phase?: RestartStatusPhase;
      canAcceptNewWork?: boolean;
      serverInstanceId?: string;
    }
  | { type: "server:restart-cleared"; serverInstanceId?: string }
  | { type: "status:connected" }
  | { type: "schedule:triggered"; sessionId?: string; scheduleId?: string; taskId?: string }
  | { type: "schedule:changed"; scheduleId?: string }
  | { type: "task:changed"; taskId?: string }
  | { type: "management-job:changed"; jobId?: string; jobType?: ManagementJobType; status?: ManagementJobStatus }
  | { type: "feed:changed"; cardId?: string; dedupeKey?: string; taskId?: string; sessionId?: string }
  | { type: "readstate:changed"; readState?: Record<string, string> };

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
