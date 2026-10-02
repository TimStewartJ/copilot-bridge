import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Bot, ChevronRight, RefreshCw, X } from "lucide-react";
import {
  cancelSessionAgent,
  fetchSessionAgentDetail,
  fetchSessionAgents,
  type AgentCountsSource,
  type AgentTaskStatus,
  type BackgroundAgentsSummary,
  type SessionAgentTask,
} from "../api";
import { hasSurfacedBackgroundAgents } from "../../shared/session-agents.js";
import {
  getTranscriptAgentActiveMs,
  type TranscriptAgent,
  type TranscriptAgentDirectory,
} from "../../shared/transcript-agents.js";
import { useNow } from "../hooks/useNow";
import { formatDuration } from "../lib/tool-presentation";
import { timeAgo } from "../time";
import { useIsMobile } from "../useIsMobile";
import ToolResultModal from "./ToolResultModal";
import { AGENT_PROSE } from "./shared/prose-classes";
import { useModalDialog } from "./shared/useModalDialog";
import { DS, cx } from "../design/tokens";
import { Button, Details, EmptyHint, IconButton, MetaLine, Notice, StatusIcon } from "../design/primitives";

interface SessionAgentsBarProps {
  sessionId: string | null;
  /** Live-gated counts from the session list; they decide whether the bar shows at all. */
  backgroundAgents?: BackgroundAgentsSummary;
  /** The session's agents as its history records them: the names they were launched under, time worked and steps taken. */
  agents?: TranscriptAgentDirectory;
  /** The newest step each agent has taken in the open run, by the call that launched the agent. */
  latestSteps?: ReadonlyMap<string, string>;
  /**
   * How many of each agent's steps the transcript has loaded, by the call that launched the agent.
   * The records are read a moment after each step, so a working agent's count comes from here.
   */
  loadedStepCounts?: ReadonlyMap<string, number>;
  /**
   * On a phone the list opens as a sheet. A parent that owns the page's history passes these so
   * the back button closes it; without them the bar keeps the state itself.
   */
  sheetOpen?: boolean;
  onOpenSheet?: () => void;
  onCloseSheet?: () => void;
}

const POLL_INTERVAL_MS = 15_000;
const REPORT_PREVIEW_CHARS = 5000;

const NON_TERMINAL: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>(["running", "idle"]);

/** Working agents first, then the ones that can still be sent a message, then the ones that ended. */
const STATUS_ORDER: Record<AgentTaskStatus, number> = {
  running: 0,
  idle: 1,
  failed: 2,
  completed: 3,
  cancelled: 3,
};

/** The word at the end of a row. A working agent needs none: its glyph turns and its time ticks. */
const STATUS_WORD: Record<AgentTaskStatus, string | undefined> = {
  running: undefined,
  idle: "idle",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * How long an agent has worked. The runtime reports the periods that have ended; the one in flight
 * is counted from when it began, by the runtime's word or, failing that, by the session's history.
 */
function getElapsedMs(task: SessionAgentTask, agent: TranscriptAgent | undefined, now: number): number | undefined {
  if (task.status !== "running") return task.activeTimeMs ?? agent?.activeMs;
  const since = parseTime(task.activeStartedAt);
  if (since !== undefined) return Math.max(0, task.activeTimeMs ?? 0) + Math.max(0, now - since);
  return agent ? getTranscriptAgentActiveMs(agent, now) : task.activeTimeMs;
}

function StatusGlyph({ status }: { status: AgentTaskStatus }) {
  switch (status) {
    case "running":
      return <StatusIcon kind="working" label="Working" />;
    case "failed":
      return <StatusIcon kind="danger" decorative />;
    case "completed":
      return <StatusIcon kind="done" decorative />;
    case "cancelled":
      return <StatusIcon kind="closed" decorative />;
    default:
      // Idle is the absence of work, and an absent state is not drawn.
      return null;
  }
}

function PanelLabel({ children }: { children: ReactNode }) {
  return <div className={cx("mb-1", DS.text.eyebrow)}>{children}</div>;
}

interface AgentRowProps {
  sessionId: string;
  task: SessionAgentTask;
  agent: TranscriptAgent | undefined;
  latestStep: string | undefined;
  loadedStepCount: number;
  now: number;
  open: boolean;
  onToggle: (agentId: string) => void;
  onStopped: () => void;
}

function AgentRow({ sessionId, task, agent, latestStep, loadedStepCount, now, open, onToggle, onStopped }: AgentRowProps) {
  const [detail, setDetail] = useState<SessionAgentTask | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [showFullReport, setShowFullReport] = useState(false);

  const name = task.name ?? agent?.name ?? task.agentType ?? "agent";
  const description = task.description ?? agent?.description;
  const working = task.status === "running";
  // A working agent says what it is doing; any other says what it was asked to do.
  const step = working ? latestStep : undefined;
  const elapsedMs = getElapsedMs(task, agent, now);
  const stateWord = STATUS_WORD[task.status];
  const stepCount = Math.max(agent?.toolCount ?? 0, loadedStepCount);

  // The list carries the start of each brief and report; an opened row reads them in full, again
  // whenever the agent changes state or the list shows it has said something new.
  const detailVersion = [
    task.status,
    task.idleSince,
    task.completedAt,
    task.activeTimeMs,
    task.result ?? task.latestResponse,
  ].join("|");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchSessionAgentDetail(sessionId, task.id, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setDetail(response.task);
      })
      // The list's own copy stays on screen; it is only shorter.
      .catch(() => {});
    return () => controller.abort();
  }, [detailVersion, open, sessionId, task.id]);

  useEffect(() => {
    if (open) return;
    setConfirmingStop(false);
    setStopError(null);
  }, [open]);

  const shown = detail ?? task;
  const report = (shown.result ?? shown.latestResponse)?.trim() || undefined;
  const brief = shown.prompt?.trim() || undefined;
  const reportLabel = working ? "Latest update" : task.status === "completed" ? "Result" : "Latest report";
  const canStop = NON_TERMINAL.has(task.status);

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      const result = await cancelSessionAgent(sessionId, task.id);
      if (!result.cancelled) setStopError("The agent could not be stopped. It may have finished already.");
      setConfirmingStop(false);
      onStopped();
    } catch (error) {
      setStopError(`Could not stop the agent: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setStopping(false);
    }
  };

  return (
    <li className="min-w-0" data-agent-id={task.id} data-agent-status={task.status}>
      <button
        type="button"
        onClick={() => onToggle(task.id)}
        aria-expanded={open}
        title={description}
        className={cx(DS.row.base, DS.row.interactive, DS.row.touch)}
      >
        <span className={DS.row.iconSlot}><StatusGlyph status={task.status} /></span>
        {/* The name keeps its width; what it is doing takes whatever is left and truncates first. */}
        <span className={cx(DS.row.label, "font-medium", task.status === "failed" ? DS.tone.danger : "text-text-secondary")}>
          {name}
        </span>
        {(step ?? description) && (
          <span className={cx(DS.row.detail, "text-text-muted")}>{step ?? description}</span>
        )}
        <span className={DS.row.trailing}>
          {stepCount > 0 && (
            <span className="hidden sm:inline">{plural(stepCount, "step")}</span>
          )}
          {stateWord && <span className={task.status === "failed" ? DS.tone.danger : undefined}>{stateWord}</span>}
          {elapsedMs !== undefined && elapsedMs >= 1000 && (
            <span>{formatDuration(elapsedMs, working ? { wholeSeconds: true } : {})}</span>
          )}
          <ChevronRight size={12} aria-hidden="true" className={cx(DS.row.chevron, open && DS.row.chevronOpen)} />
        </span>
      </button>
      {open && (
        // The rows run the width of the bar; what a row opens onto keeps a measure that reads.
        <div className={cx(DS.rail, DS.motion.reveal, "max-w-3xl space-y-3 pb-2")}>
          {step && description && <p className={DS.text.prose}>{description}</p>}
          {task.status === "failed" && shown.error && (
            <Notice tone="danger" title="This agent failed">{shown.error}</Notice>
          )}
          {report && (
            <div>
              <PanelLabel>{reportLabel}</PanelLabel>
              <div className={`${AGENT_PROSE} max-h-64 overflow-auto`}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {report.length > REPORT_PREVIEW_CHARS ? `${report.slice(0, REPORT_PREVIEW_CHARS)}\n\n... (truncated)` : report}
                </ReactMarkdown>
              </div>
              {report.length > REPORT_PREVIEW_CHARS && (
                <Button size="sm" variant="ghost" className="-ml-2.5 mt-1" onClick={() => setShowFullReport(true)}>
                  Show the full report
                </Button>
              )}
            </div>
          )}
          {!report && !working && task.status !== "failed" && (
            <EmptyHint>This agent has not reported anything.</EmptyHint>
          )}
          {brief && (
            <Details label="Brief">
              <div className={`${AGENT_PROSE} max-h-72 overflow-auto`}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{brief}</ReactMarkdown>
              </div>
            </Details>
          )}
          <MetaLine
            items={[
              task.agentType && task.agentType !== name ? task.agentType : undefined,
              task.model,
              stepCount > 0 ? plural(stepCount, "step") : undefined,
              task.startedAt ? `started ${timeAgo(task.startedAt)}` : undefined,
            ]}
          />
          {canStop && (confirmingStop ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1" role="group" aria-label={`Stop ${name}`}>
              <span className={cx("min-w-0", DS.text.rowDetail)}>
                {working
                  ? `Stop ${name}? What it has done so far stays in the transcript.`
                  : `Stop ${name}? It will take no more follow-ups.`}
              </span>
              <Button size="sm" variant="danger" disabled={stopping} onClick={() => { void stop(); }}>
                {stopping ? "Stopping…" : "Stop agent"}
              </Button>
              <Button size="sm" variant="ghost" disabled={stopping} onClick={() => setConfirmingStop(false)}>
                Keep it
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="-ml-2.5" onClick={() => { setStopError(null); setConfirmingStop(true); }}>
              Stop agent…
            </Button>
          ))}
          {stopError && <p role="alert" className="text-xs text-error">{stopError}</p>}
        </div>
      )}
      {showFullReport && report && (
        <ToolResultModal title={name} content={report} format="markdown" onClose={() => setShowFullReport(false)} />
      )}
    </li>
  );
}

/** The list on a phone: a sheet from the bottom, so the transcript keeps the screen. */
function AgentsSheet({ summary, onClose, children }: { summary: string; onClose: () => void; children: ReactNode }) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], summary, [tabindex]:not([tabindex="-1"])') ?? [],
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div {...dialogProps} ref={dialogRef} onKeyDown={keepFocusInside} className={DS.surface.compactSheet}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border py-2 pl-5 pr-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-text-primary">Agents</h2>
            <p className="truncate text-xs tabular-nums text-text-muted">{summary}</p>
          </div>
          <IconButton ref={closeButtonRef} label="Close agents" size="md" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * The agents working in the background of a session, including the ones that outlive the turn
 * that launched them. It is one line that says how many are working, and opens onto a row for each:
 * what it is doing, how long it has worked, its latest report and a way to stop it.
 *
 * The bar appears only while the session list reports live agents, so it never presents an old
 * reading as current. Opening it reads the runtime's own list of the agents it tracks.
 */
export default function SessionAgentsBar({
  sessionId,
  backgroundAgents,
  agents,
  latestSteps,
  loadedStepCounts,
  sheetOpen,
  onOpenSheet,
  onCloseSheet,
}: SessionAgentsBarProps) {
  const isMobile = useIsMobile();
  const [expandedInline, setExpandedInline] = useState(false);
  const [ownSheetOpen, setOwnSheetOpen] = useState(false);
  const [tasks, setTasks] = useState<SessionAgentTask[]>([]);
  const [source, setSource] = useState<AgentCountsSource>("unknown");
  const [refreshedAt, setRefreshedAt] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const surfaced = hasSurfacedBackgroundAgents(backgroundAgents);
  const running = backgroundAgents?.running ?? 0;
  const idle = backgroundAgents?.idle ?? 0;
  const open = isMobile ? sheetOpen ?? ownSheetOpen : expandedInline;

  const setOpen = useCallback((next: boolean) => {
    if (!isMobile) {
      setExpandedInline(next);
    } else if (next) {
      if (onOpenSheet) onOpenSheet();
      else setOwnSheetOpen(true);
    } else if (onCloseSheet) {
      onCloseSheet();
    } else {
      setOwnSheetOpen(false);
    }
  }, [isMobile, onCloseSheet, onOpenSheet]);

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
      setRefreshedAt(result.refreshedAt);
      setLoaded(true);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [sessionId]);

  // Another session's agents are another list.
  useEffect(() => {
    requestIdRef.current += 1;
    setExpandedInline(false);
    setOwnSheetOpen(false);
    setTasks([]);
    setLoaded(false);
    setLoading(false);
    setError(null);
    setOpenAgentId(null);
  }, [sessionId]);

  // Read the list when it opens and whenever the counts move; keep reading while agents are alive.
  const countsSignature = backgroundAgents
    ? `${backgroundAgents.running}:${backgroundAgents.idle}:${backgroundAgents.failed}:${backgroundAgents.total}`
    : "";
  const alive = running + idle > 0 || tasks.some((task) => NON_TERMINAL.has(task.status));
  useEffect(() => {
    if (!open || !sessionId) return;
    void load();
  }, [countsSignature, load, open, sessionId]);
  useEffect(() => {
    if (!open || !sessionId || !alive) return;
    const timer = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [alive, load, open, sessionId]);

  const listed = useMemo(() => {
    const startedAt = (task: SessionAgentTask) => parseTime(task.startedAt) ?? 0;
    return tasks
      // An agent the main agent waits on inside one turn is in the transcript, not in the background.
      .filter((task) => task.executionMode !== "sync")
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || startedAt(a) - startedAt(b));
  }, [tasks]);
  const now = useNow(open && listed.some((task) => task.status === "running"));

  const toggleAgent = useCallback((agentId: string) => {
    setOpenAgentId((current) => current === agentId ? null : agentId);
  }, []);
  const reload = useCallback(() => { void load(); }, [load]);

  // An open list stays while its reader is in it, even once the last agent has finished.
  if (!sessionId || (!surfaced && !open)) return null;

  const label = running > 0
    ? `${plural(running, "agent")} working`
    : idle > 0
      ? `${plural(idle, "agent")} idle`
      : "Agents finished";
  const detail = running > 0 && idle > 0 ? `${idle} idle` : undefined;
  const summary = detail ? `${label} · ${detail}` : label;
  const staleNote = !loaded || source === "live"
    ? undefined
    : source === "lastSeen"
      ? `Last read from the session ${timeAgo(refreshedAt) || "a while ago"}; it may have changed since.`
      : "The session is not loaded, so its agents cannot be read right now.";

  const list = (
    <>
      {error && (
        <Notice
          tone="danger"
          title="Could not read the agents"
          className="my-1"
          action={<Button size="sm" variant="ghost" onClick={reload} disabled={loading}>Try again</Button>}
        >
          {error}
        </Notice>
      )}
      {staleNote && !error && (
        <div className="flex min-w-0 items-center gap-2 py-1">
          <p className={cx("min-w-0 flex-1", DS.text.empty)}>{staleNote}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={reload}
            disabled={loading}
            icon={<RefreshCw size={11} className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />}
          >
            Refresh
          </Button>
        </div>
      )}
      {loaded && listed.length === 0 && !error && (
        <EmptyHint className="py-2">No background agents are tracked for this session.</EmptyHint>
      )}
      {!loaded && loading && !error && (
        <p role="status" className={cx("py-2", DS.text.empty, DS.motion.live)}>Reading the agents…</p>
      )}
      {listed.length > 0 && (
        <ul className="min-w-0" data-agent-list="">
          {listed.map((task) => (
            <AgentRow
              key={task.id}
              sessionId={sessionId}
              task={task}
              agent={task.toolCallId ? agents?.byToolCallId.get(task.toolCallId) : agents?.byAgentId.get(task.id)}
              latestStep={task.toolCallId ? latestSteps?.get(task.toolCallId) : undefined}
              loadedStepCount={(task.toolCallId ? loadedStepCounts?.get(task.toolCallId) : undefined) ?? 0}
              now={now}
              open={openAgentId === task.id}
              onToggle={toggleAgent}
              onStopped={reload}
            />
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div className="shrink-0 border-b border-border" data-session-agents="">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={isMobile ? undefined : open}
        aria-haspopup={isMobile ? "dialog" : undefined}
        className={cx("flex min-h-10 w-full min-w-0 items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-bg-hover/60 sm:px-4 md:min-h-9", DS.focus)}
        title="Agents working in the background of this session"
      >
        <Bot size={13} className="shrink-0 text-agent" aria-hidden="true" />
        <span className={cx("shrink-0 font-medium", running > 0 ? DS.motion.live : "text-text-secondary")}>{label}</span>
        {detail && <span className="min-w-0 truncate tabular-nums text-text-muted">{detail}</span>}
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cx("ml-auto", DS.row.chevron, open && !isMobile && DS.row.chevronOpen)}
        />
      </button>
      {open && !isMobile && (
        // Capped, with its own scroll: the list must never push the conversation off the screen.
        <div className={cx("max-h-[45vh] overflow-y-auto overscroll-contain px-3 pb-2 sm:px-4", DS.motion.reveal)}>
          {list}
        </div>
      )}
      {open && isMobile && (
        <AgentsSheet summary={summary} onClose={() => setOpen(false)}>{list}</AgentsSheet>
      )}
    </div>
  );
}
