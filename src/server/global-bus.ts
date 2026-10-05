// Global event bus for cross-session status changes
// Pushes run-state/title/intent events to all connected SSE clients

import type { DeferSummary } from "./defer-summary.js";
import type { ManagementJobStatus, ManagementJobType } from "./management-job-store.js";
import type { BackgroundAgentsSummary } from "../shared/session-agents.js";
import type { AgentBackendStatus } from "../shared/agent-backend-status.js";
import type { SendMode } from "../shared/send-mode.js";

export interface StatusEvent {
  type: "session:busy" | "session:stalled" | "session:idle" | "session:mode" | "session:title" | "session:intent" | "session:archived" | "session:agents" | "sessions:changed" | "session:user-input" | "session:defer-summary" | "session:history-truncated" | "server:restart-changed" | "schedule:triggered" | "schedule:changed" | "task:changed" | "readstate:changed" | "management-job:changed" | "backend:status" | "docs:changed";
  sessionId?: string;
  /** `session:archived` for several sessions at once; `sessionId` is then absent. */
  sessionIds?: string[];
  /** Page or collection path a `docs:changed` event is about; absent when many pages changed. */
  docPath?: string;
  reason?: string;
  jobId?: string;
  jobType?: ManagementJobType;
  status?: ManagementJobStatus;
  title?: string;
  intent?: string;
  archived?: boolean;
  pendingUserInputCount?: number;
  needsUserInput?: boolean;
  assistantPreview?: string;
  deferSummary?: DeferSummary;
  backgroundAgents?: BackgroundAgentsSummary;
  /** `session:mode`: the CLI mode the session's runs use. */
  agentMode?: SendMode;
  scheduleId?: string;
  scheduleName?: string;
  taskId?: string;
  readState?: Record<string, string>;
  agentBackend?: AgentBackendStatus;
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
