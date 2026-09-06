// Global event bus for cross-session status changes
// Pushes run-state/title/intent events to all connected SSE clients

import type { DeferSummary } from "./defer-summary.js";
import type { ManagementJobStatus, ManagementJobType } from "./management-job-store.js";
import type { RestartPhase } from "./restart-state.js";
import type { BackgroundAgentsSummary } from "../shared/session-agents.js";
import type { AgentBackendStatus } from "../shared/agent-backend-status.js";
import type { FocusObjectType } from "./focus-domain-store.js";
import type { FocusLifecycle } from "./focus-details-store.js";

export interface StatusEvent {
  type: "session:busy" | "session:stalled" | "session:idle" | "session:title" | "session:intent" | "session:archived" | "session:agents" | "sessions:changed" | "session:user-input" | "session:defer-summary" | "session:history-truncated" | "server:restart-pending" | "server:restart-cleared" | "schedule:triggered" | "schedule:changed" | "task:changed" | "readstate:changed" | "focus:changed" | "focus:protection-changed" | "focus:protection-cleared" | "feed:changed" | "management-job:changed" | "backend:status";
  protectionWindowId?: string;
  sessionId?: string;
  cardId?: string;
  focusObjectId?: string;
  focusObjectType?: FocusObjectType;
  activationId?: string;
  transitionId?: string;
  lifecycle?: FocusLifecycle;
  previousLifecycle?: FocusLifecycle;
  reason?: string;
  meaningful?: boolean;
  dedupeKey?: string;
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
  waitingSessions?: number;
  phase?: RestartPhase;
  canAcceptNewWork?: boolean;
  scheduleId?: string;
  scheduleName?: string;
  taskId?: string;
  readState?: Record<string, string>;
  serverInstanceId?: string;
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
