// Shared types for surfacing background + child agents in a session.
//
// The Copilot SDK maintains an authoritative per-session task registry
// (`session.rpc.tasks.list()`), which the Bridge projects rather than
// inferring. These shapes are the backend-neutral projection consumed by both
// the server DTO/registry and the React client.
//
// A core design rule (see session-agent-registry.ts): never present stale
// registry data as live truth. Counts carry an explicit `source` so the UI can
// distinguish authoritative live data from a last-seen snapshot or unknown
// state (e.g. after a restart, before any refresh).

export type AgentTaskStatus = "running" | "idle" | "completed" | "failed" | "cancelled";

export type AgentExecutionMode = "sync" | "background";

/**
 * Backend-neutral projection of a single SDK agent task. Sensitive free-text
 * fields (`prompt`, `result`, `latestResponse`, `error`) are only included by
 * the authorized per-session endpoint and are truncated; they are never placed
 * on the global bus or in session-list rows.
 */
export interface SessionAgentTask {
  /** Authoritative task instance id (e.g. "explore-docs"). Stable across the task lifetime. */
  id: string;
  /** Tool call id that launched the task, when available. Best-effort UI anchor; may be absent. */
  toolCallId?: string;
  /** Short human description of the task. */
  description?: string;
  status: AgentTaskStatus;
  /** sync = ran inside the launching turn; background = outlives the launching turn. */
  executionMode?: AgentExecutionMode;
  /** Agent type, e.g. "explore", "task", "general-purpose". */
  agentType?: string;
  startedAt?: string;
  completedAt?: string;
  /** Accumulated active execution time in ms, when reported. */
  activeTimeMs?: number;
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

/**
 * Freshness provenance for agent counts.
 * - `live`: refreshed from a live cached SDK session within the freshness window.
 * - `lastSeen`: a previous live snapshot that may now be stale (e.g. the session
 *   object was evicted, or the freshness window elapsed without a refresh).
 * - `unknown`: no trustworthy data (e.g. after restart before any refresh).
 */
export type AgentCountsSource = "live" | "lastSeen" | "unknown";

/**
 * Counts-only summary safe to place on the global bus and in session-list rows.
 * `running` + `idle` are the non-terminal background agents worth surfacing.
 */
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

export function emptyBackgroundAgentsSummary(
  source: AgentCountsSource = "unknown",
): BackgroundAgentsSummary {
  return { running: 0, idle: 0, failed: 0, total: 0, source };
}

/**
 * True when the summary indicates background agents the UI should actively
 * surface (running or idle) AND the data is trustworthy (live). Stale/unknown
 * data must never drive a live "agent running" indicator.
 */
export function hasSurfacedBackgroundAgents(
  summary: BackgroundAgentsSummary | undefined,
): boolean {
  if (!summary || summary.source !== "live") return false;
  return summary.running > 0 || summary.idle > 0;
}

/**
 * Derive a counts-only summary from a set of background tasks. Only
 * background-mode tasks are counted; sync subagents are surfaced through the
 * timeline/turn rendering, not the background indicator.
 */
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
