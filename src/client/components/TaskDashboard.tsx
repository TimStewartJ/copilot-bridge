import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { BatchAction, CopilotUsageModelRow, CopilotUsageSessionRow, CopilotUsageTotals, Session, Task, TaskGroup, TaskPatch } from "../api";
import { getSessionActivityTime } from "../api";
import { GROUP_COLOR_DOT } from "../group-colors";
import { timeAgo } from "../time";
import { useTaskWorkspace } from "../hooks/useTaskWorkspace";
import { useCopilotUsageQuery } from "../hooks/queries/useCopilotUsage";
import { hasTaskDashboardFocusParams } from "../lib/mobile-scroll-restoration";
import {
  getTaskCompletionCounts,
  getTaskCompletionState,
  getTaskLifecycleBadgeClass,
  getTaskLifecycleDisplayState,
  getTaskStatusLabel,
} from "../task-completion-helpers";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import TaskGitStatusSummary from "./TaskGitStatusSummary";
import { TagPillList } from "./TagPill";
import TaskKindBadge from "./TaskKindBadge";
import { getFollowUpState } from "./TaskMomentumFields";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  ClipboardCheck,
  FileText,
  FolderOpen,
  Info,
  MessageSquare,
  Milestone,
  StickyNote,
  Tags,
  TimerReset,
} from "lucide-react";

interface TaskDashboardProps {
  task: Task;
  taskGroups?: TaskGroup[];
  sessions: Session[];
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: TaskPatch) => Promise<Task | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>) => void;
  onTasksChanged?: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  onSetTaskTags?: (taskId: string, tagIds: string[]) => void;
  onRefresh?: () => Promise<void>;
  onDeleteSession?: (sessionId: string) => void;
  onDuplicateSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  exitingIds?: Set<string>;
  onBulkAction?: (action: BatchAction, sessionIds: string[]) => void;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  hasDraft?: (sessionId: string) => boolean;
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
  scrollRestoration?: PullToRefreshScrollRestoration;
}

type FocusSection = "readiness" | "session-usage";
type SignalTone = "success" | "warning" | "danger" | "info" | "muted";

interface ReadinessSignal {
  label: string;
  detail: string;
  tone: SignalTone;
}

interface ReadinessInsight {
  title: string;
  description: string;
  tone: SignalTone;
  signals: ReadinessSignal[];
}

const SIGNAL_TONE_CLASS: Record<SignalTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-error/30 bg-error/10 text-error",
  info: "border-info/30 bg-info/10 text-info",
  muted: "border-border bg-bg-surface text-text-muted",
};

const ZERO_USAGE_TOTALS: CopilotUsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

export function TaskDashboardRouteSkeleton() {
  return (
    <LoadingSkeletonRegion
      isLoading
      label="Loading task overview"
      delayMs={160}
      className="flex-1 min-h-0"
    >
      <div className="h-full min-h-0 relative">
        <div className="absolute inset-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 space-y-6">
            <header className="space-y-3">
              <div className="flex items-center gap-2">
                <Skeleton width={14} height={14} shape="circle" />
                <Skeleton width={116} height={10} shape="pill" />
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Skeleton width={72} height={18} shape="pill" />
                  <Skeleton width={56} height={18} shape="pill" />
                  <Skeleton width={90} height={18} shape="pill" />
                </div>
                <Skeleton width="58%" height={28} shape="pill" />
                <SkeletonText lines={2} widths={["72%", "52%"]} className="max-w-3xl" />
              </div>
            </header>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.05fr_0.95fr]">
              <section className="space-y-2">
                <Skeleton width={96} height={10} shape="pill" />
                <SkeletonCard className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {Array.from({ length: 6 }, (_, index) => (
                      <SkeletonCard key={index} className="space-y-2 p-3">
                        <Skeleton width="62%" height={9} shape="pill" />
                        <Skeleton width="36%" height={14} shape="pill" />
                      </SkeletonCard>
                    ))}
                  </div>
                  <SkeletonText lines={5} widths={["100%", "94%", "88%", "78%", "64%"]} />
                </SkeletonCard>
              </section>

              <section className="space-y-2">
                <Skeleton width={132} height={10} shape="pill" />
                <SkeletonCard className="space-y-4">
                  <SkeletonCard className="space-y-2 border-info/25 bg-info/10">
                    <Skeleton width="48%" height={14} shape="pill" />
                    <SkeletonText lines={2} widths={["92%", "68%"]} />
                  </SkeletonCard>
                  <SkeletonText lines={6} widths={["100%", "74%", "100%", "68%", "100%", "82%"]} />
                </SkeletonCard>
              </section>
            </div>

            <section className="space-y-2">
              <Skeleton width={104} height={10} shape="pill" />
              <SkeletonCard className="space-y-5">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
                  {Array.from({ length: 6 }, (_, index) => (
                    <SkeletonCard key={index} className="space-y-2 p-3">
                      <Skeleton width="54%" height={9} shape="pill" />
                      <Skeleton width="44%" height={14} shape="pill" />
                      <Skeleton width="64%" height={9} shape="pill" />
                    </SkeletonCard>
                  ))}
                </div>
                <SkeletonText lines={4} widths={["100%", "94%", "82%", "70%"]} />
              </SkeletonCard>
            </section>
          </div>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

export default function TaskDashboard({
  task,
  taskGroups = [],
  sessions,
  onSelectSession,
  onRefresh,
  scrollRestoration,
}: TaskDashboardProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightedSection, setHighlightedSection] = useState<FocusSection | null>(null);
  const [pendingFocusSection, setPendingFocusSection] = useState<FocusSection | null>(null);
  const readinessRef = useRef<HTMLDivElement>(null);
  const sessionUsageRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const suppressScrollRestore = hasTaskDashboardFocusParams(searchParams);
  const scrollRestorationForVisit = scrollRestoration
    ? {
        ...scrollRestoration,
        restore: scrollRestoration.restore !== false && !suppressScrollRestore,
      }
    : undefined;

  const ws = useTaskWorkspace(task, taskGroups, sessions);
  const {
    enrichedWIs,
    enrichedPRs,
    sched,
    taskGitStatus,
    checklistItems,
    checklistLoaded,
    linkedSessions,
    taskGroup: group,
    inheritedTagIds,
    effectiveTags,
    relatedDocs,
    refresh,
  } = ws;
  const { data: copilotUsage, refresh: refreshCopilotUsage } = useCopilotUsageQuery();

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!hasTaskDashboardFocusParams(searchParams)) return;

    const targetSection: FocusSection = searchParams.get("section") === "sessions"
      ? "session-usage"
      : "readiness";
    setPendingFocusSection(targetSection);

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("section");
      next.delete("checklistItem");
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!pendingFocusSection) return;

    const frameId = window.requestAnimationFrame(() => {
      const target = pendingFocusSection === "session-usage" ? sessionUsageRef.current : readinessRef.current;
      setHighlightedSection(pendingFocusSection);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedSection(null);
        highlightTimerRef.current = null;
      }, 1600);
      setPendingFocusSection(null);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [pendingFocusSection]);

  const completionCounts = useMemo(() => getTaskCompletionCounts({
    checklistItems,
    linkedSessions,
    pullRequests: enrichedPRs.length > 0
      ? enrichedPRs
      : task.pullRequests.map(() => ({ status: null })),
  }), [checklistItems, linkedSessions, enrichedPRs, task.pullRequests]);

  const completionState = useMemo(
    () => getTaskCompletionState(task, completionCounts, { checklistLoaded }),
    [task, completionCounts, checklistLoaded],
  );

  const lastActivity = useMemo(() => getLatestActivity([
    task.updatedAt,
    task.completedAt,
    ...linkedSessions.map(getSessionActivityTime),
    ...checklistItems.flatMap((item) => [item.completedAt, item.createdAt]),
    ...sched.schedules.flatMap((schedule) => [schedule.lastRunAt, schedule.updatedAt, schedule.createdAt]),
  ]), [checklistItems, linkedSessions, sched.schedules, task.completedAt, task.updatedAt]);

  const readiness = useMemo(() => buildReadinessInsight({
    task,
    checklistLoaded,
    counts: completionCounts,
    completionState,
  }), [checklistLoaded, completionCounts, completionState, task]);

  const sessionUsage = useMemo(() => buildSessionUsageAnalytics({
    taskSessionIds: task.sessionIds,
    linkedSessions,
    usageSessions: copilotUsage?.sessions ?? [],
  }), [copilotUsage?.sessions, linkedSessions, task.sessionIds]);

  const inheritedTagSet = inheritedTagIds instanceof Set
    ? inheritedTagIds
    : new Set<string>(inheritedTagIds ?? []);
  const notesExcerpt = summarizeMarkdown(task.notes);
  const contextStats = [
    { label: "Sessions", value: task.sessionIds.length },
    { label: "Checklist", value: checklistItems.length > 0 ? `${completionCounts.completedChecklistItems}/${checklistItems.length}` : "0" },
    { label: "PRs", value: task.pullRequests.length },
    { label: "Work items", value: task.workItems.length },
    { label: "Schedules", value: sched.schedules.length },
    { label: "Docs", value: relatedDocs.length },
  ];

  const handleRefresh = async () => {
    await Promise.all([refresh(), refreshCopilotUsage(), onRefresh?.()]);
  };

  return (
    <div className="flex-1 min-h-0 relative">
      <PullToRefresh
        onRefresh={handleRefresh}
        className="absolute inset-0"
        scrollRestoration={scrollRestorationForVisit}
      >
        <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 space-y-6">
          <header className="space-y-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              <CircleDot size={14} className="text-accent" />
              Task intelligence
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {group && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-bg-hover px-2 py-0.5 text-[10px] text-text-muted">
                    <span className={`h-2 w-2 rounded-full ${GROUP_COLOR_DOT[group.color] ?? "bg-slate-500"}`} />
                    {group.name}
                  </span>
                )}
                <span className={getTaskLifecycleBadgeClass(task)}>
                  {getTaskStatusLabel(task)}
                </span>
                <TaskKindBadge kind={task.kind} showTask />
                <span className="text-[10px] text-text-faint">
                  Last activity {timeAgo(lastActivity)}
                </span>
              </div>
              <h1 className="text-2xl font-semibold leading-tight text-text-primary">
                {task.title}
              </h1>
              <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
                A read-only overview of readiness, context, and recent activity. Use the task cockpit for edits and actions.
              </p>
            </div>
          </header>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <Section
              icon={<FileText size={14} />}
              title="Task brief"
            >
              <div className="rounded-xl border border-border bg-bg-secondary/70 p-4 space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {contextStats.map((stat) => (
                    <div key={stat.label} className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                        {stat.label}
                      </div>
                      <div className="mt-1 text-sm font-semibold text-text-primary">
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <BriefRow
                    icon={<StickyNote size={13} />}
                    label="Summary"
                    value={notesExcerpt || "No notes captured yet."}
                  />
                  <BriefRow
                    icon={<Milestone size={13} />}
                    label="Done when"
                    value={task.kind === "ongoing" ? "Ongoing item; no finish line required." : task.doneWhen || "No finish line defined."}
                  />
                  <BriefRow
                    icon={<ClipboardCheck size={13} />}
                    label="Next action"
                    value={task.nextAction || "No next action captured."}
                  />
                  <BriefRow
                    icon={<AlertTriangle size={13} />}
                    label="Waiting on"
                    value={task.waitingOn || "No blocker captured."}
                  />
                  <BriefRow
                    icon={<TimerReset size={13} />}
                    label="Follow-up"
                    value={formatFollowUp(task.nextTouchAt)}
                  />
                  <BriefRow
                    icon={<FolderOpen size={13} />}
                    label="Workspace"
                    value={task.cwd || "No workspace set."}
                    valueClassName={task.cwd ? "font-mono text-[11px]" : undefined}
                  />
                  {taskGitStatus && (
                    <div className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                        <FolderOpen size={12} />
                        Git status
                      </div>
                      <TaskGitStatusSummary gitStatus={taskGitStatus} className="text-[11px]" />
                    </div>
                  )}
                  <div className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
                    <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                      <Tags size={12} />
                      Tags
                    </div>
                    {effectiveTags.length > 0 ? (
                      <TagPillList tags={effectiveTags} inheritedTagIds={inheritedTagSet} size="sm" />
                    ) : (
                      <div className="text-xs text-text-muted">No tags attached.</div>
                    )}
                  </div>
                </div>
              </div>
            </Section>

            <div
              ref={readinessRef}
              className={highlightedSection === "readiness" ? "animate-checklist-highlight rounded-xl" : ""}
            >
              <Section
                icon={<CheckCircle2 size={14} />}
                title="Readiness intelligence"
              >
                <div className="rounded-xl border border-border bg-bg-secondary/70 p-4 space-y-4">
                  <div className={`rounded-lg border px-4 py-3 ${SIGNAL_TONE_CLASS[readiness.tone]}`}>
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5">
                        {readiness.tone === "success" ? <CheckCircle2 size={18} /> : <Info size={18} />}
                      </div>
                      <div>
                        <div className="text-sm font-semibold">
                          {readiness.title}
                        </div>
                        <div className="mt-1 text-xs leading-relaxed opacity-90">
                          {readiness.description}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {readiness.signals.map((signal) => (
                      <div
                        key={signal.label}
                        className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs font-medium text-text-primary">
                            {signal.label}
                          </div>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${SIGNAL_TONE_CLASS[signal.tone]}`}>
                            {signal.tone === "danger" ? "Blocking" : signal.tone === "warning" ? "Attention" : "Clear"}
                          </span>
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-text-muted">
                          {signal.detail}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>
            </div>
          </div>

          <div
            ref={sessionUsageRef}
            className={highlightedSection === "session-usage" ? "animate-checklist-highlight rounded-xl" : ""}
          >
            <Section
              icon={<MessageSquare size={14} />}
              title="Session usage"
              count={`${sessionUsage.includedSessions.length}/${Math.max(task.sessionIds.length, sessionUsage.includedSessions.length)} tokenized`}
            >
              <div className="rounded-xl border border-border bg-bg-secondary/70 p-4 space-y-5">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
                  <MetricCard label="Tokens" value={formatNumber(sessionUsage.totals.totalTokens)} sub="posted" />
                  <MetricCard label="Requests" value={formatNumber(sessionUsage.totals.requests)} sub="completed" />
                  <MetricCard label="Tokenized" value={String(sessionUsage.includedSessions.length)} sub="sessions" />
                  <MetricCard label="Pending" value={String(sessionUsage.sessionsWithoutUsage)} sub="no shutdown yet" />
                  <MetricCard label="Busy" value={String(sessionUsage.busySessions)} sub="running/stalled" />
                  <MetricCard label="Storage" value={formatBytes(sessionUsage.totalDiskSizeBytes)} sub="session files" />
                </div>

                <div className="rounded-lg border border-border/70 bg-bg-surface p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xs font-semibold text-text-primary">Tokens by day</h3>
                      <p className="mt-0.5 text-[11px] text-text-muted">
                        Based on completed assistant turns and shutdown summaries linked to this task.
                      </p>
                    </div>
                    {sessionUsage.latestUsageAt && (
                      <span className="shrink-0 text-[11px] text-text-faint">
                        Updated {timeAgo(sessionUsage.latestUsageAt)}
                      </span>
                    )}
                  </div>
                  {sessionUsage.dayBuckets.length > 0 ? (
                    <div className="space-y-2">
                      {sessionUsage.dayBuckets.map((bucket) => (
                        <div key={bucket.key} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3">
                          <div className="text-[11px] text-text-muted">{bucket.label}</div>
                          <div className="h-2 rounded-full bg-bg-hover">
                            <div
                              className="h-2 rounded-full bg-accent"
                              style={{ width: `${Math.max(6, Math.round((bucket.totalTokens / sessionUsage.maxDayTokens) * 100))}%` }}
                            />
                          </div>
                          <div className="text-right text-[11px] font-medium text-text-primary">
                            {formatNumber(bucket.totalTokens)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                      No token totals yet. Tokens appear here after linked sessions complete assistant turns or write usage summaries.
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="rounded-lg border border-border/70 bg-bg-surface p-3">
                    <h3 className="mb-2 text-xs font-semibold text-text-primary">Heaviest sessions</h3>
                    {sessionUsage.topSessions.length > 0 ? (
                      <div className="space-y-2">
                        {sessionUsage.topSessions.map((row) => (
                          <div key={row.sessionId} className="rounded-md border border-border/60 bg-bg-secondary/60 px-3 py-2">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-text-primary">
                                  {row.label}
                                </div>
                                <div className="mt-0.5 text-[11px] text-text-muted">
                                  {row.shutdownAt ? `Usage posted ${timeAgo(row.shutdownAt)}` : "Usage posted without a timestamp"}
                                  {row.models.length > 0 ? ` · ${row.models.map((model) => model.model).join(", ")}` : ""}
                                </div>
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="text-xs font-semibold text-text-primary">{formatNumber(row.totalTokens)}</div>
                                <div className="text-[10px] text-text-faint">{formatNumber(row.requests)} req</div>
                              </div>
                            </div>
                            {row.hasLoadedSession && (
                              <button
                                onClick={() => onSelectSession(row.sessionId)}
                                className="mt-2 text-xs font-medium text-accent hover:text-accent-hover"
                              >
                                Open session
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                        Linked sessions do not have token summaries yet.
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-border/70 bg-bg-surface p-3">
                    <h3 className="mb-2 text-xs font-semibold text-text-primary">Models used</h3>
                    {sessionUsage.modelRows.length > 0 ? (
                      <div className="space-y-2">
                        {sessionUsage.modelRows.map((row) => (
                          <div key={row.model} className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-md border border-border/60 bg-bg-secondary/60 px-3 py-2">
                            <div className="min-w-0">
                              <div className="truncate text-xs font-medium text-text-primary">{row.model}</div>
                              <div className="text-[11px] text-text-muted">
                                {row.sessions} {row.sessions === 1 ? "session" : "sessions"} · {formatNumber(row.requests)} requests
                              </div>
                            </div>
                            <div className="text-right text-xs font-semibold text-text-primary">
                              {formatNumber(row.totalTokens)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                        Model breakdown will appear after session usage is available.
                      </div>
                    )}
                  </div>
                </div>

                {sessionUsage.sessionsWithoutUsage > 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-xs text-info">
                    <Info size={14} className="mt-0.5 shrink-0" />
                    <p>
                      {sessionUsage.sessionsWithoutUsage} linked {sessionUsage.sessionsWithoutUsage === 1 ? "session has" : "sessions have"} no token total yet.
                      Running or recently active sessions usually post usage after assistant turns complete or after shutdown.
                    </p>
                  </div>
                )}
              </div>
            </Section>
          </div>
        </div>
      </PullToRefresh>
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-text-primary">
        {value}
      </div>
      <div className="text-[10px] text-text-muted">
        {sub}
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number | string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {icon}
          {title}
          {count !== undefined && (
            <span className="font-normal text-text-faint">({count})</span>
          )}
        </h2>
      </div>
      {children}
    </section>
  );
}

function BriefRow({
  icon,
  label,
  value,
  valueClassName = "",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-faint">
        {icon}
        {label}
      </div>
      <div className={`text-xs leading-relaxed text-text-secondary ${valueClassName}`.trim()}>
        {value}
      </div>
    </div>
  );
}

function buildReadinessInsight({
  task,
  checklistLoaded,
  counts,
  completionState,
}: {
  task: Task;
  checklistLoaded?: boolean;
  counts: ReturnType<typeof getTaskCompletionCounts>;
  completionState: ReturnType<typeof getTaskCompletionState>;
}): ReadinessInsight {
  const lifecycle = getTaskLifecycleDisplayState(task);
  const signals: ReadinessSignal[] = [];

  if (lifecycle === "completed") {
    signals.push({
      label: "Completion",
      detail: task.doneWhen ? `Finished against: ${task.doneWhen}` : "This task is already completed.",
      tone: "success",
    });
    return {
      title: "Completed",
      description: task.completedAt ? `Completed ${timeAgo(task.completedAt)}.` : "This task is already complete.",
      tone: "success",
      signals,
    };
  }

  if (lifecycle === "archived") {
    signals.push({
      label: "Lifecycle",
      detail: "This task is manually archived, so completion readiness is not active.",
      tone: "muted",
    });
    return {
      title: "Archived",
      description: "Archived tasks are hidden from active work until reopened from the cockpit or task list.",
      tone: "muted",
      signals,
    };
  }

  if (task.kind === "ongoing") {
    signals.push({
      label: "Ongoing item",
      detail: "Ongoing items stay active and do not use the one-off completion flow.",
      tone: "info",
    });
    signals.push({
      label: "Momentum",
      detail: task.nextAction || task.waitingOn || task.nextTouchAt
        ? "Momentum context is captured in the brief."
        : "No next action, blocker, or follow-up is captured yet.",
      tone: task.nextAction || task.waitingOn || task.nextTouchAt ? "success" : "warning",
    });
    return {
      title: "Ongoing work",
      description: "This dashboard tracks context and recent activity, but ongoing items are not completed.",
      tone: "info",
      signals,
    };
  }

  if (checklistLoaded === false) {
    signals.push({
      label: "Checklist loading",
      detail: "Checklist items have not finished loading, so readiness may change.",
      tone: "warning",
    });
  }
  if (counts.openChecklistItems > 0) {
    signals.push({
      label: "Open checklist",
      detail: `${counts.openChecklistItems} checklist ${counts.openChecklistItems === 1 ? "item remains" : "items remain"}.`,
      tone: "danger",
    });
  }
  if (counts.busySessions > 0) {
    signals.push({
      label: "Busy sessions",
      detail: `${counts.busySessions} linked ${counts.busySessions === 1 ? "session is" : "sessions are"} still running or stalled.`,
      tone: "danger",
    });
  }
  if (counts.activePullRequests > 0) {
    signals.push({
      label: "Active PRs",
      detail: `${counts.activePullRequests} linked ${counts.activePullRequests === 1 ? "PR is" : "PRs are"} still active.`,
      tone: "danger",
    });
  }
  if (counts.unknownPullRequests > 0) {
    signals.push({
      label: "Unknown PR status",
      detail: `${counts.unknownPullRequests} linked ${counts.unknownPullRequests === 1 ? "PR has" : "PRs have"} unknown status.`,
      tone: "warning",
    });
  }
  if (!task.doneWhen) {
    signals.push({
      label: "Finish line",
      detail: "No Done when definition is captured for this task.",
      tone: "warning",
    });
  }
  if (task.waitingOn) {
    signals.push({
      label: "Explicit blocker",
      detail: task.waitingOn,
      tone: "danger",
    });
  }

  const hasExplicitBlocker = Boolean(task.waitingOn);

  if (completionState.isReadyToComplete && task.doneWhen && !hasExplicitBlocker) {
    signals.push({
      label: "Completion signals",
      detail: completionState.ctaDescription,
      tone: "success",
    });
    return {
      title: "Ready to complete",
      description: "No blocking checklist, session, or PR signals are left.",
      tone: "success",
      signals,
    };
  }

  if (completionState.isReadyToComplete && !hasExplicitBlocker) {
    return {
      title: "Ready with a missing finish line",
      description: "Operational blockers are clear, but the task brief has no Done when definition.",
      tone: "warning",
      signals,
    };
  }

  return {
    title: "Not ready",
    description: completionState.blockers.length > 0
      ? completionState.blockers.join(" • ")
      : "One or more readiness signals need attention.",
    tone: signals.some((signal) => signal.tone === "danger") ? "danger" : "warning",
    signals,
  };
}

interface SessionUsageDisplayRow extends CopilotUsageTotals {
  sessionId: string;
  label: string;
  shutdownAt: string | null;
  models: CopilotUsageModelRow[];
  hasLoadedSession: boolean;
}

interface SessionUsageDayBucket extends CopilotUsageTotals {
  key: string;
  label: string;
  sessionIds: Set<string>;
}

function buildSessionUsageAnalytics({
  taskSessionIds,
  linkedSessions,
  usageSessions,
}: {
  taskSessionIds: string[];
  linkedSessions: Session[];
  usageSessions: CopilotUsageSessionRow[];
}) {
  const taskSessionIdSet = new Set(taskSessionIds);
  const linkedSessionMap = new Map(linkedSessions.map((session) => [session.sessionId, session]));
  const includedSessions = usageSessions.filter((row) => taskSessionIdSet.has(row.sessionId));
  const includedSessionIds = new Set(includedSessions.map((row) => row.sessionId));
  const totals = { ...ZERO_USAGE_TOTALS };
  const modelTotals = new Map<string, CopilotUsageModelRow>();
  const dayBuckets = new Map<string, SessionUsageDayBucket>();

  for (const row of includedSessions) {
    addUsageTotals(totals, row);
    for (const model of row.models) {
      const existing = modelTotals.get(model.model) ?? { ...ZERO_USAGE_TOTALS, model: model.model, sessions: 0 };
      existing.sessions += model.sessions;
      addUsageTotals(existing, model);
      modelTotals.set(model.model, existing);
    }

    const bucketKey = row.shutdownAt?.slice(0, 10);
    if (bucketKey) {
      const bucket = dayBuckets.get(bucketKey) ?? {
        ...ZERO_USAGE_TOTALS,
        key: bucketKey,
        label: formatDateLabel(row.shutdownAt!),
        sessionIds: new Set<string>(),
      };
      addUsageTotals(bucket, row);
      bucket.sessionIds.add(row.sessionId);
      dayBuckets.set(bucketKey, bucket);
    }
  }

  const topSessions: SessionUsageDisplayRow[] = includedSessions
    .map((row) => {
      const session = linkedSessionMap.get(row.sessionId);
      return {
        ...row,
        label: session?.summary || session?.intentText || `Session ${row.sessionId.slice(0, 8)}`,
        hasLoadedSession: Boolean(session),
      };
    })
    .sort((left, right) => (
      right.totalTokens - left.totalTokens
      || compareNullableTimestampStringsDesc(left.shutdownAt, right.shutdownAt)
      || left.sessionId.localeCompare(right.sessionId)
    ))
    .slice(0, 5);

  const modelRows = [...modelTotals.values()].sort((left, right) => (
    right.totalTokens - left.totalTokens
    || right.requests - left.requests
    || left.model.localeCompare(right.model)
  ));

  const sortedDayBuckets = [...dayBuckets.values()]
    .sort((left, right) => right.key.localeCompare(left.key));
  const maxDayTokens = Math.max(1, ...sortedDayBuckets.map((bucket) => bucket.totalTokens));
  const latestUsageAt = includedSessions.reduce<string | null>(
    (latest, row) => row.shutdownAt ? maxNullableTimestamp(latest, row.shutdownAt) : latest,
    null,
  );
  const sessionsWithoutUsage = Math.max(0, taskSessionIdSet.size - includedSessionIds.size);

  return {
    totals,
    includedSessions,
    sessionsWithoutUsage,
    busySessions: linkedSessions.filter((session) => session.busy || session.runState === "busy" || session.runState === "stalled").length,
    totalDiskSizeBytes: linkedSessions.reduce((sum, session) => sum + (session.diskSizeBytes ?? 0), 0),
    dayBuckets: sortedDayBuckets,
    maxDayTokens,
    modelRows,
    topSessions,
    latestUsageAt,
  };
}

function getLatestActivity(values: Array<string | undefined>): string {
  const valid = values.filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value)));
  if (valid.length === 0) return new Date().toISOString();
  return valid.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest, valid[0]);
}

function summarizeMarkdown(value: string): string {
  const plain = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_\-~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 180) return plain;
  return `${plain.slice(0, 177).trim()}...`;
}

function formatFollowUp(value?: string): string {
  if (!value) return "No follow-up scheduled.";
  const state = getFollowUpState(value);
  const prefix = state === "overdue" ? "Overdue" : state === "due" ? "Due now" : "Scheduled";
  return `${prefix}: ${formatDateTime(value)} (${timeAgo(value)})`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatBytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}

function addUsageTotals(target: CopilotUsageTotals, delta: CopilotUsageTotals): void {
  target.requests += delta.requests;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.totalTokens += delta.totalTokens;
}

function maxNullableTimestamp(current: string | null, candidate: string): string {
  return !current || candidate > current ? candidate : current;
}

function compareNullableTimestampStringsDesc(left: string | null, right: string | null): number {
  if (left && right) return right.localeCompare(left);
  if (left) return -1;
  if (right) return 1;
  return 0;
}
