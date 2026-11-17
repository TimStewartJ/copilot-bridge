// Projection of the SDK task registry; counts carry `source` so stale data never looks live.

export type AgentTaskStatus = "running" | "idle" | "completed" | "failed" | "cancelled";

export type AgentExecutionMode = "sync" | "background";

/** Free-text fields: truncated, per-session endpoint only; never on the bus or in list rows. */
export interface SessionAgentTask {
  /** Authoritative task instance id (e.g. "explore-docs"). Stable across the task lifetime. */
  id: string;
  /** Tool call id that launched the task, when available. Best-effort UI anchor; may be absent. */
  toolCallId?: string;
  /** The name the agent was launched under ("moves-agent"), when the runtime reports one. */
  name?: string;
  /** Short human description of the task. */
  description?: string;
  status: AgentTaskStatus;
  /** sync = ran inside the launching turn; background = outlives the launching turn. */
  executionMode?: AgentExecutionMode;
  /** Agent type, e.g. "explore", "task", "general-purpose". */
  agentType?: string;
  startedAt?: string;
  completedAt?: string;
  /** Active execution time in ms over the periods of work that have ended, when reported. */
  activeTimeMs?: number;
  /** When the current stretch of work began, if reported; absent while the agent is not working. */
  activeStartedAt?: string;
  /** When the agent entered idle (awaiting a follow-up message), when reported. */
  idleSince?: string;
  model?: string;
  /** Error message when status is "failed". Truncated by the endpoint. */
  error?: string;
  /** Prompt given to the agent. Truncated by the endpoint; omitted elsewhere. */
  prompt?: string;
  /** Result text when available. Truncated by the endpoint; omitted elsewhere. */
  result?: string;
  /** Most recent response text. Truncated by the endpoint; omitted elsewhere. */
  latestResponse?: string;
}

/** live: fresh from SDK; lastSeen: earlier snapshot, maybe stale; unknown: nothing trustworthy. */
export type AgentCountsSource = "live" | "lastSeen" | "unknown";

/** Counts only, safe for the global bus and list rows; `running` + `idle` are worth surfacing. */
export interface BackgroundAgentsSummary {
  /** Background agents actively executing. */
  running: number;
  /** Background agents idle/awaiting a follow-up message (steerable). */
  idle: number;
  /** Background agents that ended in failure and have not been cleared. */
  failed: number;
  /** Total tracked background agents (all statuses). */
  total: number;
  source: AgentCountsSource;
  /** ISO timestamp of the last successful live refresh, when known. */
  refreshedAt?: string;
}

export interface BackgroundAgentsAggregate {
  /** Live background agents actively executing across all tracked sessions. */
  running: number;
  /** Live background agents idle/awaiting a follow-up message. */
  idle: number;
  /** Live background agents that ended in failure and have not been cleared. */
  failed: number;
  /** Total background agents in live snapshots, including terminal tasks. */
  total: number;
  /** Tracked sessions whose agent snapshot is still within the freshness window. */
  liveSessions: number;
  /** Tracked sessions with a previously-live snapshot that is now stale. */
  staleSessions: number;
  /** Tracked sessions that have not completed a successful live refresh. */
  unknownSessions: number;
}

export const TERMINAL_AGENT_STATUSES: readonly AgentTaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
] as const;

export function isTerminalAgentStatus(status: AgentTaskStatus): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status);
}

/** unavailable: not loaded; not-found: untracked; running: stop first; refused: runtime kept it. */
export type AgentDismissRefusal = "unavailable" | "not-found" | "running" | "refused";

/** Only an agent off the runtime's list stops counting as one of the session's live contexts. */
export type AgentDismissResult =
  | { dismissed: true }
  | { dismissed: false; reason: AgentDismissRefusal };

export function emptyBackgroundAgentsSummary(
  source: AgentCountsSource = "unknown",
): BackgroundAgentsSummary {
  return { running: 0, idle: 0, failed: 0, total: 0, source };
}

/** Only live data may drive the running indicator; lastSeen/unknown never do. */
export function hasSurfacedBackgroundAgents(
  summary: BackgroundAgentsSummary | undefined,
): boolean {
  if (!summary || summary.source !== "live") return false;
  return summary.running > 0 || summary.idle > 0;
}

/** Counts background-mode tasks only; sync sub-agents show in the timeline instead. */
export function summarizeBackgroundAgents(
  tasks: readonly SessionAgentTask[],
  source: AgentCountsSource,
  refreshedAt?: string,
): BackgroundAgentsSummary {
  let running = 0;
  let idle = 0;
  let failed = 0;
  let total = 0;
  for (const task of tasks) {
    if (task.executionMode && task.executionMode !== "background") continue;
    total += 1;
    if (task.status === "running") running += 1;
    else if (task.status === "idle") idle += 1;
    else if (task.status === "failed") failed += 1;
  }
  return { running, idle, failed, total, source, ...(refreshedAt ? { refreshedAt } : {}) };
}
