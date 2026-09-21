import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import {
  cancelSessionAgent,
  fetchSessionAgents,
  type AgentTaskStatus,
  type BackgroundAgentsSummary,
  type SessionAgentTask,
} from "../api";
import { hasSurfacedBackgroundAgents } from "../../shared/session-agents.js";
import { DS, cx } from "../design/tokens";
import { Badge, Button, EmptyHint } from "../design/primitives";

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

const STATUS_TONE: Record<AgentTaskStatus, "info" | "warning" | "success" | "danger" | "neutral"> = {
  running: "info",
  idle: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
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
    <div className="shrink-0 border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={cx("flex min-h-9 w-full items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-bg-hover/60 sm:px-4", DS.focus)}
        title="Background agents working in this session"
      >
        <Bot size={13} className="shrink-0 text-agent" aria-hidden="true" />
        <span className={cx("font-medium", running > 0 ? DS.motion.live : "text-text-secondary")}>
          {active} background agent{active === 1 ? "" : "s"}
        </span>
        <span className="truncate tabular-nums text-text-muted">
          {running > 0 && `${running} running`}
          {running > 0 && idle > 0 && " · "}
          {idle > 0 && `${idle} idle`}
        </span>
        <ChevronRight size={12} aria-hidden="true" className={cx("ml-auto", DS.row.chevron, expanded && DS.row.chevronOpen)} />
      </button>
      {expanded && (
        <div className={cx("px-3 pb-2 sm:px-4", DS.motion.reveal)}>
          <div className="flex min-h-7 items-center justify-between">
            <span className={DS.text.sectionLabel}>
              Agents{liveLabel ? ` · ${liveLabel}` : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void load()}
              disabled={loading}
              icon={<RefreshCw size={11} className={loading ? "animate-spin" : ""} />}
            >
              Refresh
            </Button>
          </div>
          {error && (
            <div className="mb-2 text-xs text-error" role="alert">{error}</div>
          )}
          {agentTasks.length === 0 && !loading && !error && (
            <EmptyHint className="py-1">No background agents are currently tracked for this session.</EmptyHint>
          )}
          <ul className={DS.surface.divided}>
            {agentTasks.map((task) => {
              const duration = formatDuration(task);
              const isCancelling = cancelling.has(task.id);
              const canCancel = NON_TERMINAL.has(task.status);
              return (
                <li key={task.id} className="flex min-h-9 items-center gap-2 py-1 text-[13px]">
                  <span className="shrink-0 text-text-secondary">{task.agentType ?? "agent"}</span>
                  <span className="min-w-0 flex-1 truncate text-text-muted">
                    {task.description || task.id}
                  </span>
                  {duration && (
                    <span className={cx("shrink-0", DS.text.meta)}>{duration}</span>
                  )}
                  <Badge tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Badge>
                  {canCancel && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleCancel(task.id)}
                      disabled={isCancelling}
                    >
                      {isCancelling ? <Loader2 size={11} className="animate-spin" /> : "Cancel"}
                    </Button>
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
