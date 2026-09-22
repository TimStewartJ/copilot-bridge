import { useMemo } from "react";
import type {
  BatchAction,
  CopilotUsageCostBreakdownUsd,
  CopilotUsageCostEstimate,
  CopilotUsageModelRow,
  CopilotUsageSessionRow,
  CopilotUsageTotals,
  Session,
  Task,
  TaskGroup,
  TaskPatch,
} from "../api";
import { getSessionActivityTime, isSessionActive } from "../api";
import { COPILOT_USAGE_UNATTRIBUTED_MODEL } from "../../shared/copilot-usage";
import { GROUP_COLOR_DOT } from "../group-colors";
import { timeAgo } from "../time";
import { useTaskWorkspace } from "../hooks/useTaskWorkspace";
import { useCopilotUsageQuery } from "../hooks/queries/useCopilotUsage";
import { useTaskSessionStorageQuery } from "../hooks/queries/useTaskSessionStorage";
import {
  getTaskCompletionCounts,
  getTaskCompletionState,
  getTaskLifecycleDisplayState,
  getTaskStatusLabel,
} from "../task-completion-helpers";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import TaskGitStatusSummary from "./TaskGitStatusSummary";
import { TagPillList } from "./TagPill";
import TaskKindBadge from "./TaskKindBadge";
import { formatRevisit } from "../lib/task-revisit";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";
import { DS, cx } from "../design/tokens";
import { Badge, EmptyHint, Field, FieldList, Notice, Section, StatRow } from "../design/primitives";
import { describeMeteredCoverage, formatUsageCredits as formatAiCredits, formatUsageNumber as formatNumber, formatUsageUsd as formatUsd, meteredCostUsd } from "../lib/usage-presentation";
import UsageModelList from "./usage/UsageModelList";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FolderOpen,
  GitBranch,
  Info,
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
  onForkSession?: (sessionId: string) => void;
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

const NOTICE_TONE: Record<SignalTone, "success" | "warning" | "danger" | "info" | "neutral"> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
  muted: "neutral",
};

const LIFECYCLE_TONE: Record<ReturnType<typeof getTaskLifecycleDisplayState>, "success" | "neutral" | "info"> = {
  completed: "success",
  archived: "neutral",
  active: "info",
};

const ZERO_USAGE_TOTALS: CopilotUsageTotals = {
  requests: 0,
  inputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  meteredAiCredits: 0,
  meteredTokens: 0,
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
          <div className={cx(DS.layout.pageColumn, "space-y-8")}>
            <header className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Skeleton width={72} height={14} shape="pill" />
                <Skeleton width={56} height={14} shape="pill" />
                <Skeleton width={110} height={14} shape="pill" />
              </div>
              <Skeleton width="58%" height={28} shape="pill" />
              <SkeletonText lines={1} widths={["64%"]} className="max-w-3xl" />
            </header>

            <StatRowSkeleton count={6} />

            <div className="grid grid-cols-1 gap-x-12 gap-y-8 lg:grid-cols-[1.05fr_0.95fr]">
              <section className="space-y-4">
                <Skeleton width={84} height={12} shape="pill" />
                <FieldListSkeleton rows={6} />
              </section>
              <section className="space-y-4">
                <Skeleton width={148} height={12} shape="pill" />
                <SkeletonText lines={2} widths={["88%", "64%"]} />
                <FieldListSkeleton rows={3} />
              </section>
            </div>

            <section className="space-y-5">
              <Skeleton width={104} height={12} shape="pill" />
              <SessionUsageSkeleton />
            </section>
          </div>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

function StatRowSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-1.5">
          <Skeleton width={44} height={18} shape="pill" />
          <Skeleton width={64} height={9} shape="pill" />
        </div>
      ))}
    </div>
  );
}

function FieldListSkeleton({ rows }: { rows: number }) {
  return (
    <div className={DS.surface.divided}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-4 py-3">
          <Skeleton width={72} height={10} shape="pill" />
          <Skeleton width={index % 2 === 0 ? "82%" : "56%"} height={10} shape="pill" />
        </div>
      ))}
    </div>
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
  const {
    data: copilotUsage,
    isLoading: copilotUsageLoading,
    error: copilotUsageError,
    refresh: refreshCopilotUsage,
  } = useCopilotUsageQuery({ taskId: task.id, sessionIds: task.sessionIds });
  const {
    data: sessionStorage,
    isLoading: sessionStorageLoading,
    refetch: refetchSessionStorage,
  } = useTaskSessionStorageQuery(
    task.id,
    task.sessionIds,
    task.sessionIds.length > 0,
  );

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
    totalDiskSizeBytes: sessionStorage?.totalDiskSizeBytes ?? 0,
  }), [copilotUsage?.sessions, linkedSessions, sessionStorage?.totalDiskSizeBytes, task.sessionIds]);
  const isSessionUsageLoading = (copilotUsageLoading && !copilotUsage)
    || Boolean(
      copilotUsage?.index.state === "scanning"
      && (copilotUsage.index.requestedSessionsCached ?? 0)
        < (copilotUsage.index.requestedSessions ?? task.sessionIds.length),
    );

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
    await Promise.all([
      refresh(),
      refreshCopilotUsage(),
      task.sessionIds.length > 0 ? refetchSessionStorage() : undefined,
      onRefresh?.(),
    ]);
  };

  return (
    <div className="flex-1 min-h-0 relative">
      <PullToRefresh
        onRefresh={handleRefresh}
        className="absolute inset-0"
        scrollRestoration={scrollRestoration}
      >
        <div className={cx(DS.layout.pageColumn, "space-y-8")}>
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              {group && (
                <span className="inline-flex items-center gap-1.5">
                  <span className={cx(DS.dot, GROUP_COLOR_DOT[group.color] ?? "bg-slate-500")} aria-hidden="true" />
                  {group.name}
                </span>
              )}
              <Badge tone={LIFECYCLE_TONE[getTaskLifecycleDisplayState(task)]}>{getTaskStatusLabel(task)}</Badge>
              <TaskKindBadge kind={task.kind} showTask />
              <span className={DS.text.meta}>Last activity {timeAgo(lastActivity)}</span>
            </div>
            <h1 className={DS.text.pageTitle}>
              {task.title}
            </h1>
            <p className={cx(DS.text.prose, "max-w-3xl")}>
              Task context, completion checks and activity.
            </p>
          </header>

          <StatRow stats={contextStats} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.05fr_0.95fr]">
            <Section level="page" label="Task brief" surface>
              <FieldList>
                <Field icon={<StickyNote size={13} />} label="Summary" empty="No notes yet.">
                  {notesExcerpt}
                </Field>
                <Field
                  icon={<Milestone size={13} />}
                  label="Done when"
                  empty={task.kind === "ongoing" ? "No fixed finish line." : "Not set."}
                >
                  {task.kind === "ongoing" ? undefined : task.doneWhen}
                </Field>
                {task.deferred && <Field label="Deferred">Set aside until resumed. Automation is unchanged.</Field>}
                <Field icon={<ClipboardCheck size={13} />} label="Next step" empty="Not set.">
                  {task.nextAction}
                </Field>
                <Field label="Waiting for" empty="Not set.">
                  {task.waitingOn}
                </Field>
                <Field icon={<TimerReset size={13} />} label="Revisit on" empty="Not set.">
                  {task.nextTouchAt ? formatFollowUp(task.nextTouchAt) : undefined}
                </Field>
                <Field icon={<FolderOpen size={13} />} label="Workspace" empty="No workspace set." mono>
                  {task.cwd}
                </Field>
                {taskGitStatus && (
                  <Field icon={<GitBranch size={13} />} label="Git status">
                    <TaskGitStatusSummary gitStatus={taskGitStatus} />
                  </Field>
                )}
                <Field icon={<Tags size={13} />} label="Tags" empty="No tags attached.">
                  {effectiveTags.length > 0
                    ? <TagPillList tags={effectiveTags} inheritedTagIds={inheritedTagSet} size="sm" />
                    : undefined}
                </Field>
              </FieldList>
            </Section>

            <Section level="page" label="Completion checks" surface>
              <Notice
                tone={NOTICE_TONE[readiness.tone]}
                role="status"
                icon={readiness.tone === "success" ? <CheckCircle2 size={15} /> : <Info size={15} />}
                title={<span className="text-[13px]">{readiness.title}</span>}
              >
                {readiness.description}
              </Notice>

              <div className={cx(DS.surface.divided, "mt-2")}>
                {readiness.signals.map((signal) => (
                  <div key={signal.label} className="py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[13px] font-medium text-text-primary">
                        {signal.label}
                      </div>
                      <Badge tone={signal.tone === "danger" ? "danger" : signal.tone === "warning" ? "warning" : "neutral"}>
                        {signal.tone === "danger" ? "Blocking" : signal.tone === "warning" ? "Check" : signal.tone === "success" ? "Clear" : "Context"}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                      {signal.detail}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>

          <Section
            surface
            level="page"
            label="Session usage"
            count={isSessionUsageLoading
              ? undefined
              : `${sessionUsage.includedSessions.length}/${Math.max(task.sessionIds.length, sessionUsage.includedSessions.length)} tokenized`}
          >
            {copilotUsageError && (
              <Notice tone="danger" icon={<AlertTriangle size={14} />} className="mb-3">
                Could not refresh task usage: {copilotUsageError instanceof Error ? copilotUsageError.message : String(copilotUsageError)}.
                {copilotUsage ? " The previous reading is still shown." : " No usage totals are available."}
              </Notice>
            )}
            {copilotUsage?.index.state === "error" && (
              <Notice tone="danger" icon={<AlertTriangle size={14} />} className="mb-3">
                {copilotUsage.index.error ?? "Task usage indexing failed; cached readings are shown."}
              </Notice>
            )}
            {copilotUsage?.index.warning && (
              <Notice tone="warning" icon={<AlertTriangle size={14} />} className="mb-3">{copilotUsage.index.warning}</Notice>
            )}
            {isSessionUsageLoading ? (
              <LoadingSkeletonRegion
                isLoading
                label="Loading session usage"
                className="space-y-6"
              >
                <SessionUsageSkeleton />
              </LoadingSkeletonRegion>
            ) : copilotUsageError && !copilotUsage ? null : (
              <div className="space-y-7">
                {copilotUsage?.index.state === "scanning" && (
                  <Notice tone="info" icon={<Info size={14} />}>
                    Usage is still indexing in the background. These task totals update as linked sessions are cached.
                  </Notice>
                )}
                <StatRow
                  stats={[
                    { label: "Tokens", value: formatNumber(sessionUsage.totals.totalTokens), detail: "posted" },
                    ...(sessionUsage.cost.hasCostEstimate
                      ? [{
                        label: "Est. cost",
                        value: formatUsd(sessionUsage.cost.estimatedCostUsd),
                        detail: `${formatAiCredits(sessionUsage.cost.estimatedAiCredits)} AI credits`,
                      }]
                      : []),
                    {
                      label: "Metered cost",
                      value: formatUsd(meteredCostUsd(sessionUsage.totals)),
                      detail: meteredCostUsd(sessionUsage.totals) !== null ? describeMeteredCoverage(sessionUsage.totals) : "No SDK metering recorded",
                    },
                    { label: "Requests", value: formatNumber(sessionUsage.totals.requests), detail: "completed" },
                    { label: "Tokenized", value: String(sessionUsage.includedSessions.length), detail: "sessions" },
                    { label: "Pending", value: String(sessionUsage.sessionsWithoutUsage), detail: "no shutdown yet" },
                    { label: "Busy", value: String(sessionUsage.busySessions), detail: "running/stalled" },
                    {
                      label: "Storage",
                      value: sessionStorageLoading && !sessionStorage ? "..." : formatBytes(sessionUsage.totalDiskSizeBytes),
                      detail: "session files",
                    },
                  ]}
                />

                <Section
                  label="Tokens by day"
                  action={sessionUsage.latestUsageAt
                    ? <span className={DS.usage.meta}>Updated {timeAgo(sessionUsage.latestUsageAt)}</span>
                    : undefined}
                >
                  <p className={cx(DS.text.empty, "mb-3")}>
                    Based on completed assistant turns and shutdown summaries linked to this task.
                  </p>
                  {sessionUsage.dayBuckets.length > 0 ? (
                    <div className="space-y-2">
                      {sessionUsage.dayBuckets.map((bucket) => (
                        <div key={bucket.key} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 text-xs tabular-nums">
                          <div className="text-text-secondary">{bucket.label}</div>
                          <div className={DS.meter.track}>
                            <div
                              className={DS.meter.fill}
                              style={{ width: `${(bucket.totalTokens / sessionUsage.maxDayTokens) * 100}%`, minWidth: bucket.totalTokens > 0 ? 2 : undefined }}
                            />
                          </div>
                          <div className="min-w-[5.5rem] text-right text-text-primary">
                            {formatNumber(bucket.totalTokens)}
                            {bucket.hasCostEstimate && (
                              <span className="ml-2 text-text-secondary">{formatUsd(bucket.estimatedCostUsd)} est.</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyHint>
                      No token totals yet. Tokens appear here after linked sessions complete assistant turns or write usage summaries.
                    </EmptyHint>
                  )}
                </Section>

                <div className="grid grid-cols-1 gap-x-12 gap-y-7 lg:grid-cols-2">
                  <Section label="Heaviest sessions">
                    {sessionUsage.topSessions.length > 0 ? (
                      <div className={DS.surface.divided}>
                        {sessionUsage.topSessions.map((row) => {
                          const body = (
                            <>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-medium text-text-primary">
                                  {row.label}
                                </div>
                                <div className="mt-0.5 truncate text-xs text-text-muted">
                                  {row.shutdownAt ? `Usage posted ${timeAgo(row.shutdownAt)}` : "Usage posted without a timestamp"}
                                  {row.models.length > 0 ? ` · ${row.models.map((model) => model.model).join(", ")}` : ""}
                                </div>
                              </div>
                              <div className="shrink-0 text-right tabular-nums">
                                <div className="text-[13px] font-medium text-text-primary">{formatNumber(row.totalTokens)}</div>
                                <div className={DS.usage.meta}>
                                  {formatNumber(row.requests)} req
                                  {row.hasCostEstimate ? ` · ${formatUsd(row.estimatedCostUsd)} est.` : ""}
                                </div>
                              </div>
                            </>
                          );
                          return row.hasLoadedSession ? (
                            <button
                              key={row.sessionId}
                              type="button"
                              onClick={() => onSelectSession(row.sessionId)}
                              title="Open session"
                              className={cx("-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-hover/60", DS.focus)}
                            >
                              {body}
                            </button>
                          ) : (
                            <div key={row.sessionId} className="flex items-center gap-3 py-2">
                              {body}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyHint>Linked sessions do not have token summaries yet.</EmptyHint>
                    )}
                  </Section>

                  <Section label="Models used">
                    {sessionUsage.modelRows.length > 0 ? <UsageModelList models={sessionUsage.modelRows} /> : (
                      <EmptyHint>Model breakdown will appear after session usage is available.</EmptyHint>
                    )}
                  </Section>
                </div>

                {(sessionUsage.sessionsWithoutUsage > 0 || sessionUsage.cost.unpricedModelNames.length > 0) && (
                  <div className="space-y-2">
                    {sessionUsage.sessionsWithoutUsage > 0 && (
                      <Notice tone="info" icon={<Info size={14} />}>
                        {sessionUsage.sessionsWithoutUsage} linked {sessionUsage.sessionsWithoutUsage === 1 ? "session has" : "sessions have"} no token total yet.
                        Running or recently active sessions usually post usage after assistant turns complete or after shutdown.
                      </Notice>
                    )}
                    {sessionUsage.cost.unpricedModelNames.length > 0 && (
                      <Notice tone="warning" role="status" icon={<AlertTriangle size={14} />}>
                        Estimated cost excludes {formatNumber(sessionUsage.cost.unpricedTokens.totalTokens)} tokens from unpriced linked{" "}
                        {sessionUsage.cost.unpricedModelNames.length === 1 ? "model" : "models"}: {sessionUsage.cost.unpricedModelNames.slice(0, 3).join(", ")}
                        {sessionUsage.cost.unpricedModelNames.length > 3 ? ` +${sessionUsage.cost.unpricedModelNames.length - 3} more` : ""}.
                      </Notice>
                    )}
                  </div>
                )}
              </div>
            )}
          </Section>
        </div>
      </PullToRefresh>
    </div>
  );
}
function SessionUsageSkeleton() {
  return (
    <>
      <StatRowSkeleton count={6} />

      <div className="space-y-3">
        <Skeleton height={10} width={96} shape="pill" />
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3">
            <Skeleton height={9} width={52} shape="pill" />
            <Skeleton height={6} width="100%" shape="pill" />
            <Skeleton height={9} width={56} shape="pill" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-x-12 gap-y-7 lg:grid-cols-2">
        {["Heaviest sessions", "Models used"].map((label) => (
          <div key={label} className="space-y-1">
            <Skeleton height={10} width={label === "Models used" ? 78 : 110} shape="pill" />
            <div className={DS.surface.divided}>
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton height={10} width="74%" shape="pill" />
                    <Skeleton height={9} width="52%" shape="pill" />
                  </div>
                  <Skeleton height={12} width={48} shape="pill" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
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
      detail: "Archived without marking complete.",
      tone: "muted",
    });
    return {
      title: "Archived",
      description: "Reopen from the task list to continue.",
      tone: "muted",
      signals,
    };
  }

  if (task.kind === "ongoing") {
    signals.push({
      label: "Ongoing",
      detail: "No fixed finish line.",
      tone: "info",
    });
    signals.push({
      label: "Where things stand",
      detail: task.nextAction || task.waitingOn || task.nextTouchAt
        ? "See next steps and waits in the task brief."
        : "No next step needed until there is work to do.",
      tone: "muted",
    });
    return {
      title: "Ongoing work",
      description: "Keep the context; add next steps as needed.",
      tone: "info",
      signals,
    };
  }

  if (checklistLoaded === false) {
    signals.push({
      label: "Checklist loading",
      detail: "Checks are incomplete until the checklist loads.",
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
  if (task.waitingOn) {
    signals.push({
      label: "Waiting for",
      detail: task.waitingOn,
      tone: "muted",
    });
  }

  if (completionState.isReadyToComplete) {
    signals.push({
      label: "Completion signals",
      detail: completionState.ctaDescription,
      tone: "success",
    });
    return {
      title: "Completion checks clear",
      description: "No open checklist, session or PR checks. Confirm the outcome before completing.",
      tone: "success",
      signals,
    };
  }

  return {
    title: "Not ready",
    description: completionState.blockers.length > 0
      ? completionState.blockers.join(" • ")
      : "Review the checks below.",
    tone: signals.some((signal) => signal.tone === "danger") ? "danger" : "warning",
    signals,
  };
}

interface SessionUsageCostFields extends CopilotUsageCostEstimate {
  hasCostEstimate: boolean;
}

interface SessionUsageCostRollup extends SessionUsageCostFields {
  unpricedModelNames: string[];
  unpricedTokens: CopilotUsageTotals;
}

interface SessionUsageDisplayRow extends CopilotUsageTotals, CopilotUsageCostEstimate {
  sessionId: string;
  label: string;
  shutdownAt: string | null;
  models: CopilotUsageModelRow[];
  hasLoadedSession: boolean;
  hasCostEstimate: boolean;
  hasUnpricedUsage: boolean;
}

interface SessionUsageModelDisplayRow extends CopilotUsageTotals, CopilotUsageCostEstimate {
  model: string;
  sessions: number;
  hasCostEstimate: boolean;
  hasUnpricedUsage: boolean;
}

interface SessionUsageDayBucket extends CopilotUsageTotals, CopilotUsageCostEstimate {
  key: string;
  label: string;
  sessionIds: Set<string>;
  hasCostEstimate: boolean;
}

export function buildSessionUsageAnalytics({
  taskSessionIds,
  linkedSessions,
  usageSessions,
  totalDiskSizeBytes,
}: {
  taskSessionIds: string[];
  linkedSessions: Session[];
  usageSessions: CopilotUsageSessionRow[];
  totalDiskSizeBytes: number;
}) {
  const taskSessionIdSet = new Set(taskSessionIds);
  const linkedSessionMap = new Map(linkedSessions.map((session) => [session.sessionId, session]));
  const includedSessions = usageSessions.filter((row) => taskSessionIdSet.has(row.sessionId));
  const includedSessionIds = new Set(includedSessions.map((row) => row.sessionId));
  const totals = { ...ZERO_USAGE_TOTALS };
  const costTotals = createSessionUsageCostFields();
  const unpricedTokens = { ...ZERO_USAGE_TOTALS };
  const unpricedModelNames = new Set<string>();
  const modelTotals = new Map<string, SessionUsageModelDisplayRow>();
  const dayBuckets = new Map<string, SessionUsageDayBucket>();

  for (const row of includedSessions) {
    addUsageTotals(totals, row);
    addUsageCostEstimate(costTotals, row);
    for (const unpricedModel of getUnpricedModelRows(row)) {
      addUsageTotals(unpricedTokens, unpricedModel);
      unpricedModelNames.add(unpricedModel.model);
    }

    for (const model of row.models ?? []) {
      const existing = modelTotals.get(model.model) ?? createSessionUsageModelRow(model.model);
      existing.sessions += model.sessions;
      addUsageTotals(existing, model);
      addUsageCostEstimate(existing, model);
      existing.hasUnpricedUsage ||= isUnpricedUsageModel(model);
      modelTotals.set(model.model, existing);
    }

    for (const day of row.days ?? []) {
      const bucket = dayBuckets.get(day.date) ?? {
        ...ZERO_USAGE_TOTALS,
        ...createZeroCostEstimate(),
        key: day.date,
        label: formatUsageDayLabel(day.date),
        sessionIds: new Set<string>(),
        hasCostEstimate: false,
      };
      addUsageTotals(bucket, day);
      addUsageCostEstimate(bucket, day);
      bucket.sessionIds.add(row.sessionId);
      dayBuckets.set(day.date, bucket);
    }
  }

  const topSessions: SessionUsageDisplayRow[] = includedSessions
    .map((row) => {
      const session = linkedSessionMap.get(row.sessionId);
      const { estimate, hasCostEstimate } = normalizeUsageCostEstimate(row);
      return {
        ...row,
        ...estimate,
        models: row.models ?? [],
        label: session?.summary || session?.intentText || `Session ${row.sessionId.slice(0, 8)}`,
        hasLoadedSession: Boolean(session),
        hasCostEstimate,
        hasUnpricedUsage: getUnpricedModelRows(row).length > 0,
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
    cost: {
      ...costTotals,
      unpricedTokens,
      unpricedModelNames: [...unpricedModelNames].sort((left, right) => left.localeCompare(right)),
    } satisfies SessionUsageCostRollup,
    includedSessions,
    sessionsWithoutUsage,
    busySessions: linkedSessions.filter((session) => isSessionActive(session)).length,
    totalDiskSizeBytes,
    dayBuckets: sortedDayBuckets,
    maxDayTokens,
    modelRows,
    topSessions,
    latestUsageAt,
  };
}

function getLatestActivity(values: Array<string | undefined>): string {
  const valid = values.filter((value): value is string => (
    typeof value === "string" && !Number.isNaN(Date.parse(value))
  ));
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
  return value ? formatRevisit(value) : "No revisit date set.";
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

function formatUsageDayLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return formatDateLabel(value);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
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

function createSessionUsageModelRow(model: string): SessionUsageModelDisplayRow {
  return {
    ...ZERO_USAGE_TOTALS,
    ...createZeroCostEstimate(),
    model,
    sessions: 0,
    hasCostEstimate: false,
    hasUnpricedUsage: false,
  };
}

function createSessionUsageCostFields(): SessionUsageCostFields {
  return {
    ...createZeroCostEstimate(),
    hasCostEstimate: false,
  };
}

function createZeroCostEstimate(): CopilotUsageCostEstimate {
  return {
    estimatedCostUsd: 0,
    estimatedAiCredits: 0,
    costBreakdownUsd: createZeroCostBreakdownUsd(),
    billableOutputTokens: 0,
    reasoningPricingAssumption: "reasoning_tokens_priced_at_output_rate",
  };
}

function createZeroCostBreakdownUsd(): CopilotUsageCostBreakdownUsd {
  return {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

function addUsageTotals(target: CopilotUsageTotals, delta: CopilotUsageTotals): void {
  target.requests += delta.requests;
  target.inputTokens += delta.inputTokens;
  target.uncachedInputTokens += delta.uncachedInputTokens ?? 0;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.totalTokens += delta.totalTokens;
  target.meteredAiCredits += delta.meteredAiCredits ?? 0;
  target.meteredTokens += delta.meteredTokens ?? 0;
}

function addUsageCostEstimate(target: SessionUsageCostFields, delta: Partial<CopilotUsageCostEstimate>): void {
  const { estimate, hasCostEstimate } = normalizeUsageCostEstimate(delta);
  if (!hasCostEstimate) return;

  target.hasCostEstimate = true;
  target.estimatedCostUsd += estimate.estimatedCostUsd;
  target.estimatedAiCredits += estimate.estimatedAiCredits;
  target.billableOutputTokens += estimate.billableOutputTokens;
  target.reasoningPricingAssumption = estimate.reasoningPricingAssumption;
  target.costBreakdownUsd.input += estimate.costBreakdownUsd.input;
  target.costBreakdownUsd.cachedInput += estimate.costBreakdownUsd.cachedInput;
  target.costBreakdownUsd.cacheWrite += estimate.costBreakdownUsd.cacheWrite;
  target.costBreakdownUsd.output += estimate.costBreakdownUsd.output;
  target.costBreakdownUsd.reasoning += estimate.costBreakdownUsd.reasoning;
  target.costBreakdownUsd.total += estimate.costBreakdownUsd.total;
}

function normalizeUsageCostEstimate(source: Partial<CopilotUsageCostEstimate>): { estimate: CopilotUsageCostEstimate; hasCostEstimate: boolean } {
  const breakdown = source.costBreakdownUsd;
  if (
    !isFiniteNumber(source.estimatedCostUsd)
    || !isFiniteNumber(source.estimatedAiCredits)
    || !breakdown
    || !isFiniteNumber(breakdown.input)
    || !isFiniteNumber(breakdown.cachedInput)
    || !isFiniteNumber(breakdown.cacheWrite)
    || !isFiniteNumber(breakdown.output)
    || !isFiniteNumber(breakdown.reasoning)
    || !isFiniteNumber(breakdown.total)
  ) {
    return { estimate: createZeroCostEstimate(), hasCostEstimate: false };
  }

  return {
    estimate: {
      estimatedCostUsd: source.estimatedCostUsd,
      estimatedAiCredits: source.estimatedAiCredits,
      costBreakdownUsd: { ...breakdown },
      billableOutputTokens: isFiniteNumber(source.billableOutputTokens) ? source.billableOutputTokens : 0,
      reasoningPricingAssumption: source.reasoningPricingAssumption ?? "reasoning_tokens_priced_at_output_rate",
    },
    hasCostEstimate: true,
  };
}

function getUnpricedModelRows(row: CopilotUsageSessionRow): Array<CopilotUsageModelRow | CopilotUsageSessionRow["unpricedModels"][number]> {
  const reported = Array.isArray(row.unpricedModels) ? row.unpricedModels : [];
  if (reported.length > 0) return reported;
  return (row.models ?? []).filter(isUnpricedUsageModel);
}

function isUnpricedUsageModel(model: Pick<CopilotUsageModelRow, "model" | "pricingStatus">): boolean {
  return model.pricingStatus === "unpriced"
    && model.model !== COPILOT_USAGE_UNATTRIBUTED_MODEL;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
