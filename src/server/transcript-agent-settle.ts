import type { SessionAgentTask } from "../shared/session-agents.js";
import type { TranscriptAgent } from "../shared/transcript-agents.js";

/**
 * How much later than an agent's turn began the runtime's list must have been read before it can
 * overrule the log. An event's timestamp and the time of the read are only roughly comparable.
 */
const RUNTIME_LIST_MARGIN_MS = 2_000;

export interface RuntimeAgentList {
  tasks: readonly SessionAgentTask[];
  /** When the list was last read from the runtime; absent when it never was. */
  refreshedAt?: string;
}

/**
 * Corrects agents the event log still shows working when the runtime knows they are not.
 *
 * The log records that an agent stopped only when the runtime gets to write it. A process that was
 * killed, a run that was stopped, and some follow-up turns leave no such event, and the agent would
 * read as working for good. The runtime's own list of the agents it tracks settles it: a list read
 * after the agent's turn began that does not show the agent running means the agent is not
 * running, however old that read is, because only a later turn could change it and the log shows
 * when the latest turn began.
 *
 * Agents another agent launched are left to the log: the list is only known to name the agents the
 * main agent launched.
 */
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
