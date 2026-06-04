import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import {
  cancelSessionAgent,
  fetchSessionAgents,
  type AgentTaskStatus,
  type BackgroundAgentsSummary,
  type SessionAgentTask,
} from "../api";
import { hasSurfacedBackgroundAgents } from "../../shared/session-agents.js";

interface SessionAgentsBarProps {
  sessionId: string | null;
  /** Live-gated counts from the session list; drives whether the banner shows at all. */
  backgroundAgents?: BackgroundAgentsSummary;
}

const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  running: "Running",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASS: Record<AgentTaskStatus, string> = {
  running: "bg-info/15 text-info",
  idle: "bg-warning/15 text-warning",
  completed: "bg-success/15 text-success",
  failed: "bg-error/15 text-error",
  cancelled: "bg-text-faint/15 text-text-muted",
};

const NON_TERMINAL: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>(["running", "idle"]);

function formatDuration(task: SessionAgentTask): string | null {
  if (typeof task.activeTimeMs === "number" && task.activeTimeMs > 0) {
    const seconds = Math.round(task.activeTimeMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }
  return null;
}

/**
 * Slim, persistent bar surfacing a session's background agents — including the
 * ones that outlive the launching turn. The banner only appears when the
 * session-list summary reports *live* background agents, so it never presents
 * stale data as active. Expanding fetches the authoritative per-session
 * snapshot (which triggers a server-side live refresh) and lists each agent.
 */
export default function SessionAgentsBar({ sessionId, backgroundAgents }: SessionAgentsBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState<SessionAgentTask[]>([]);
  const [source, setSource] = useState<string>("unknown");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const requestIdRef = useRef(0);

  const surfaced = hasSurfacedBackgroundAgents(backgroundAgents);
  const running = backgroundAgents?.running ?? 0;
  const idle = backgroundAgents?.idle ?? 0;
  const active = running + idle;

  const load = useCallback(async () => {
    if (!sessionId) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSessionAgents(sessionId);
      if (requestId !== requestIdRef.current) return;
      setTasks(result.tasks);
      setSource(result.source);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [sessionId]);

  // Collapse + reset when the surfaced banner disappears or the session changes.
  useEffect(() => {
    setExpanded(false);
    setTasks([]);
    setError(null);
  }, [sessionId]);

  // Fetch when expanded; poll while non-terminal agents remain visible.
  useEffect(() => {
    if (!expanded || !sessionId) return;
    void load();
    const hasNonTerminal = tasks.some((task) => NON_TERMINAL.has(task.status)) || active > 0;
    if (!hasNonTerminal) return;
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, sessionId, load]);

  const handleCancel = useCallback(async (agentId: string) => {
    if (!sessionId) return;
    setCancelling((prev) => new Set(prev).add(agentId));
    try {
      await cancelSessionAgent(sessionId, agentId);
      await load();
    } catch {
      /* surfaced via list refresh */
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, [sessionId, load]);

  if (!sessionId || !surfaced) return null;

  const agentTasks = tasks.filter((task) => task.executionMode !== "sync");
  const liveLabel = source === "live" ? null : source === "lastSeen" ? "last seen" : "status unknown";

  return (
    <div className="shrink-0 border-b border-border bg-agent-muted/40">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs hover:bg-bg-hover/50 transition-colors"
        title="Background agents working in this session"
      >
        <Bot size={13} className={`text-agent shrink-0${running > 0 ? " animate-pulse" : ""}`} />
        <span className="font-medium text-agent">
          {active} background agent{active === 1 ? "" : "s"}
        </span>
        <span className="text-text-muted truncate">
          {running > 0 && `${running} running`}
          {running > 0 && idle > 0 && " · "}
          {idle > 0 && `${idle} idle`}
        </span>
        <span className="ml-auto shrink-0 text-text-faint">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/60 px-4 py-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-text-faint">
              Agents{liveLabel ? ` · ${liveLabel}` : ""}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
          {error && (
            <div className="mb-2 text-[11px] text-error">{error}</div>
          )}
          {agentTasks.length === 0 && !loading && !error && (
            <div className="py-1 text-[11px] text-text-muted">
              No background agents are currently tracked for this session.
            </div>
          )}
          <ul className="space-y-1">
            {agentTasks.map((task) => {
              const duration = formatDuration(task);
              const isCancelling = cancelling.has(task.id);
              const canCancel = NON_TERMINAL.has(task.status);
              return (
                <li
                  key={task.id}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-bg-secondary/60 px-2.5 py-1.5 text-xs"
                >
                  <Bot size={12} className="shrink-0 text-agent" />
                  <span className="shrink-0 font-mono text-[11px] text-text-secondary">
                    {task.agentType ?? "agent"}
                  </span>
                  <span className="truncate text-text-muted">
                    {task.description || task.id}
                  </span>
                  <span
                    className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[task.status]}`}
                  >
                    {STATUS_LABEL[task.status]}
                  </span>
                  {duration && (
                    <span className="shrink-0 text-[10px] text-text-faint">{duration}</span>
                  )}
                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => void handleCancel(task.id)}
                      disabled={isCancelling}
                      className="shrink-0 text-[10px] text-text-faint hover:text-error transition-colors disabled:opacity-50"
                    >
                      {isCancelling ? <Loader2 size={11} className="animate-spin" /> : "Cancel"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
