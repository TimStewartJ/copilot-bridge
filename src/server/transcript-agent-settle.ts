import type { SessionAgentTask } from "../shared/session-agents.js";
import type { TranscriptAgent } from "../shared/transcript-agents.js";

/** How long after a turn began the runtime list must be read to overrule the log. */
const RUNTIME_LIST_MARGIN_MS = 2_000;

export interface RuntimeAgentList {
  tasks: readonly SessionAgentTask[];
  /** When the list was last read from the runtime; absent when it never was. */
  refreshedAt?: string;
}

/** Any runtime list read after the turn began settles it; skip nested agents (list omits them). */
export function settleTranscriptAgents(
  agents: TranscriptAgent[],
  runtime: RuntimeAgentList,
): TranscriptAgent[] {
  const readAt = runtime.refreshedAt ? Date.parse(runtime.refreshedAt) : Number.NaN;
  if (!Number.isFinite(readAt) || !agents.some((agent) => agent.status === "running")) return agents;

  const byToolCallId = new Map<string, SessionAgentTask>();
  const byId = new Map<string, SessionAgentTask>();
  for (const task of runtime.tasks) {
    if (task.toolCallId) byToolCallId.set(task.toolCallId, task);
    byId.set(task.id, task);
  }

  let settledAny = false;
  const settled = agents.map((agent): TranscriptAgent => {
    if (agent.status !== "running" || agent.parentToolCallId) return agent;
    const since = Date.parse(agent.activeSince ?? agent.startedAt ?? "");
    if (!Number.isFinite(since) || since + RUNTIME_LIST_MARGIN_MS > readAt) return agent;
    const task = byToolCallId.get(agent.toolCallId) ?? (agent.agentId ? byId.get(agent.agentId) : undefined);
    if (task?.status === "running") return agent;

    settledAny = true;
    const { activeSince: _activeSince, ...rest } = agent;
    const endedAt = task?.idleSince ?? task?.completedAt;
    return {
      ...rest,
      // An agent the runtime no longer tracks at all was cut short: its process or its run ended.
      status: !task || task.status === "cancelled" ? "stopped" : task.status === "failed" ? "failed" : "finished",
      ...(endedAt ? { endedAt } : {}),
      activeMs: typeof task?.activeTimeMs === "number" && task.activeTimeMs > agent.activeMs
        ? task.activeTimeMs
        : agent.activeMs,
    };
  });
  return settledAny ? settled : agents;
}
