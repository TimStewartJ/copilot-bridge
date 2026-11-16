import TaskDatesSection, { useTaskDatesQuery } from "../calendar/TaskDatesSection";
import { TaskStartersSection } from "./task-sections/TaskStartersSection";
import type { TaskStarter } from "../../shared/task-starters.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Task, TaskGroup, Session } from "../api";
import { fetchTaskGitStatus, patchTask, startTaskPageChat, startTaskTidy } from "../api";
import { useToast } from "../useToast";
import { useTaskWorkspace } from "../hooks/useTaskWorkspace";
import { useTaskAttention } from "../hooks/useTaskAttention";
import type { TaskSessionSource } from "../hooks/useTaskIndicators";
import TaskAttentionBadge from "./TaskAttentionBadge";
import { useSessionWorkspaceQuery } from "../hooks/queries/useSessionWorkspace";
import { queryKeys } from "../queryClient";
import { getTaskCompletionCounts, getTaskCompletionState } from "../task-completion-helpers";
import { areWorkspacePathsEqual } from "../lib/workspace-presentation";
import {
  resolveTaskPanelChecklistHighlight,
} from "../task-detail-focus";
import TaskSessionList from "./TaskSessionList";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import NotesSheet from "./NotesSheet";
import TaskPageSection, { RemoveTaskPageItem, TaskPageSlot, useTaskPageQuery } from "./TaskPageSection";
import TaskHistorySheet, { describeHistoryActor, useTaskHistory } from "./TaskHistorySheet";
import { TagPillList } from "./TagPill";
import TagPicker from "./TagPicker";
import TaskKindBadge from "./TaskKindBadge";
import {
  FolderOpen,
  LayoutDashboard,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  MoreHorizontal,
  Plus,
  RotateCcw,
  History,
  ScrollText,
  Sparkles,
} from "lucide-react";
import DocPreviewSheet from "./DocPreviewSheet";
import TaskMomentumFields from "./TaskMomentumFields";
import RevisitPrompt from "./RevisitPrompt";
import TaskMomentumHistory from "./TaskMomentumHistory";
import TaskPanelSummaryRow, { type TaskPanelSummaryChip } from "./TaskPanelSummaryRow";
import TaskPlaybookRow from "./TaskPlaybookRow";
import { describeTaskGitStatusSummary } from "../lib/task-git-status-summary";
import { getTaskPanelAgentSetupExpanded, setTaskPanelAgentSetupExpanded } from "../task-panel-disclosure-state";
import { useRevealWhenSettled } from "../hooks/useRevealWhenSettled";
import { useTaskStartersQuery } from "../hooks/queries/useTaskStarters";
import { TaskContextMenu } from "./task-list";
import { CtxItem } from "./ContextMenu";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";
import { LoadingSkeletonRegion, Skeleton, SkeletonRow, SkeletonText } from "./shared/Skeleton";
import { DS, cx } from "../design/tokens";
import { Button, IconButton, Section, IdentitySwatch } from "../design/primitives";
import {
  WorkItemList,
  PullRequestList,
  TaskChecklistSection,
  TaskNotesSection,
  RelatedDocsSection,
  ScheduleSection,
} from "./task-sections";


/** Chats the panel lists before "Show more"; the open chat is always listed. */
const TASK_PANEL_CHAT_LIMIT = 5;

function getPathTail(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

interface TaskPanelProps {
  task: Task | null;
  taskGroups?: TaskGroup[];
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  /** Opens a new chat with a suggested prompt; false when it didn't. Leaving it out hides suggestions. */
  onStartSuggestedChat?: (taskId: string, starter: TaskStarter) => boolean;
  onUpdateTask: (
    taskId: string,
    updates: Parameters<typeof patchTask>[1],
  ) => Promise<Task | null>;
  onTasksChanged?: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  readStateReady?: boolean;
  readStateError?: string;
  sessionSource?: TaskSessionSource;
  onArchiveSession?: (id: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  exitingIds?: Set<string>;
  tasks?: Task[];
  onLinkToTask?: (sessionId: string, taskId: string) => void;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  hasDraft?: (sessionId: string) => boolean;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onRefresh?: () => Promise<void>;
  onViewDashboard?: (taskId: string) => void;
  onMarkAllRead?: () => void;
  onBulkAction?: (action: import("../api").BatchAction, sessionIds: string[]) => void;
  onSetTaskTags?: (taskId: string, tagIds: string[]) => void;
  scrollRestoration?: PullToRefreshScrollRestoration;
}

export function TaskPanelRouteSkeleton() {
  return (
    <LoadingSkeletonRegion
      isLoading
      label="Loading task cockpit"
      delayMs={160}
      className="flex-1 min-w-0 min-h-0 relative"
    >
      <div className={cx(DS.surface.pane, "absolute inset-0 overflow-y-auto overflow-x-hidden")}>
        <div className={cx(DS.surface.group, "mx-3 mt-3 space-y-3 p-3")}>
          <div className="flex items-start gap-2">
            <Skeleton width="82%" height={18} shape="pill" />
            <Skeleton width={16} height={16} shape="rounded" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Skeleton width={48} height={14} shape="pill" />
            <Skeleton width={72} height={14} shape="pill" />
            <Skeleton width={48} height={14} shape="pill" />
          </div>
          <Skeleton width="100%" height={36} shape="rounded" />
        </div>

        <div className="space-y-3 px-3 pb-6 pt-3">
          <section className={cx(DS.layout.section, "space-y-2")}>
            <Skeleton width={72} height={10} shape="pill" />
            <SkeletonText lines={2} widths={["100%", "68%"]} />
          </section>
          <section className={cx(DS.layout.section, "space-y-1")}>
            <Skeleton width={64} height={10} shape="pill" className="mb-2" />
            <SkeletonRow leading={false} className="px-0" />
            <SkeletonRow leading={false} className="px-0" />
            <SkeletonRow leading={false} className="px-0" />
          </section>
          <section className={cx(DS.layout.section, "space-y-1")}>
            <Skeleton width={72} height={10} shape="pill" className="mb-2" />
            <SkeletonRow leading="square" className="px-0" />
            <SkeletonRow leading="square" className="px-0" />
          </section>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}
export default function TaskPanel({
  task,
  taskGroups = [],
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onStartSuggestedChat,
  onUpdateTask,
  onTasksChanged,
  isUnread,
  readStateReady,
  readStateError,
  sessionSource,
  onArchiveSession,
  archivingIds,
  exitingIds,
  tasks,
  onLinkToTask,
  onUnlinkFromTask,
  onDeleteTask,
  onDeleteSession,
  onForkSession,
  onReloadSession,
  onMarkUnread,
  hasDraft,
  onMoveTaskToGroup,
  onRefresh,
  onViewDashboard,
  onMarkAllRead,
  onBulkAction,
  onSetTaskTags,
  scrollRestoration,
}: TaskPanelProps) {
  const queryClient = useQueryClient();
  const { showToast, dismissToast } = useToast();

  /** Starts a chat the Bridge writes the first message for, and opens it. */
  async function startPresetChat(
    start: () => Promise<{ sessionId: string; error?: string }>,
    copy: { starting: string; failed: string },
  ) {
    const toastId = showToast({ tone: "info", title: copy.starting, loading: true, durationMs: 0, haptic: false });
    try {
      const started = await start();
      if (started.error) showToast({ id: toastId, tone: "error", title: started.error, loading: false, durationMs: undefined });
      else dismissToast(toastId);
      onSelectSession(started.sessionId);
    } catch (error) {
      showToast({ id: toastId, tone: "error", title: copy.failed, description: error instanceof Error ? error.message : String(error), loading: false, durationMs: undefined });
    }
  }
  const startTidy = (taskId: string) => startPresetChat(() => startTaskTidy(taskId), {
    starting: "Starting a tidy-up chat", failed: "Couldn't start the tidy-up chat",
  });
  const startPage = (taskId: string) => startPresetChat(() => startTaskPageChat(taskId), {
    starting: "Starting a chat to make the page", failed: "Couldn't start the page chat",
  });
  const ws = useTaskWorkspace(task ?? undefined, taskGroups, sessions);
  const {
    enrichedWIs,
    enrichedPRs,
    sched,
    schedDetail,
    notes,
    instructionsSheet,
    historySheet,
    taskGitStatus,
    checklistItems,
    checklistItemsReady,
    checklistLoaded,
    createChecklistItemMutation,
    onChecklistItemUpdate,
    onChecklistItemDelete,
    newChecklistItemText,
    setNewChecklistItemText,
    linkedSessions,
    taskOwnTags,
    taskGroup: group,
    inheritedTagIds,
    effectiveTags,
    relatedDocs,
    refresh,
  } = ws;
  const activeSession = linkedSessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const sessionWorkspaceQuery = useSessionWorkspaceQuery(activeSession?.sessionId, task?.id);
  const { data: historySummary } = useTaskHistory(task?.id ?? "", 1, Boolean(task));

  const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightChecklistItemId, setHighlightChecklistItemId] = useState<string | null>(null);
  const [panelHighlightRequest, setPanelHighlightRequest] = useState<{ highlightId: string | null } | null>(null);
  const [momentumTask, setMomentumTask] = useState(task);
  const [isUpdatingCompletion, setIsUpdatingCompletion] = useState(false);
  const [taskMenuPosition, setTaskMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [checklistComposerOpen, setChecklistComposerOpen] = useState(false);
  const [agentSetupExpanded, setAgentSetupExpanded] = useState(getTaskPanelAgentSetupExpanded);
  const sessionMap = useMemo(() => new Map(sessions.map((session) => [session.sessionId, session])), [sessions]);
  const activeLinkedSessionCount = linkedSessions.filter((session) => !session.archived).length;
  const highlightTimerRef = useRef<number | null>(null);
  const latestTaskIdRef = useRef(task?.id ?? null);
  const pendingChecklistItemId = searchParams.get("checklistItem");

  // Everything below the chats loads separately; it appears in one step, so nothing a reader is about
  // to tap above it moves. The chats and everything above them come from data already in memory.
  const startersShown = Boolean(onStartSuggestedChat && task?.status === "active" && !task.completedAt);
  // A task that is archived without being completed has no Status fields, so its page stays in Linked.
  const pageInStatus = Boolean(task && !(task.status === "archived" && !task.completedAt));
  const pageQuery = useTaskPageQuery(task?.id ?? "", Boolean(task));
  const startersQuery = useTaskStartersQuery(task?.id ?? "", Boolean(task) && startersShown);
  const datesQuery = useTaskDatesQuery(task?.id ?? "", Boolean(task));
  const lowerSettled = checklistLoaded
    && (pageInStatus || !pageQuery.isPending)
    && (!startersShown || !startersQuery.isPending)
    && datesQuery.settled
    && sched.settled
    && ws.relatedDocsSettled;
  const lowerRevealed = useRevealWhenSettled(task?.id ?? "", lowerSettled);


  const openWorkspaceSheet = () => {
    setWorkspaceSheetOpen(true);
    if (!task) return;

    if (task.cwd?.trim()) {
      void queryClient.fetchQuery({
        queryKey: queryKeys.taskGitStatus(task.id),
        queryFn: ({ signal }) => fetchTaskGitStatus(task.id, { signal, refresh: true }),
        staleTime: 0,
      }).catch((error: unknown) => {
        console.warn(`[task-panel] Failed to refresh workspace git status: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    if (activeSession?.sessionId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessionWorkspace(activeSession.sessionId, task.id),
      }).catch((error: unknown) => {
        console.warn(`[task-panel] Failed to refresh session workspace details: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  };

  useEffect(() => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setPreviewDocPath(null);
    setWorkspaceSheetOpen(false);
    setTaskMenuPosition(null);
    setChecklistComposerOpen(false);
    setHighlightChecklistItemId(null);
    setPanelHighlightRequest(null);
  }, [task?.id]);

  useEffect(() => {
    const resolvedHighlight = resolveTaskPanelChecklistHighlight({
      focusedChecklistItemId: pendingChecklistItemId,
      checklistItems,
      checklistItemsReady,
    });

    if (!pendingChecklistItemId || !resolvedHighlight.consumeParam || !lowerRevealed) return;

    setPanelHighlightRequest({ highlightId: resolvedHighlight.highlightId });
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("checklistItem");
      return next;
    }, { replace: true });
  }, [checklistItems, checklistItemsReady, lowerRevealed, pendingChecklistItemId, setSearchParams]);

  useEffect(() => {
    if (!panelHighlightRequest) return;

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }

    setHighlightChecklistItemId(null);

    const frameId = requestAnimationFrame(() => {
      if (!panelHighlightRequest.highlightId) return;

      setHighlightChecklistItemId(panelHighlightRequest.highlightId);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightChecklistItemId((current) => (
          current === panelHighlightRequest.highlightId ? null : current
        ));
        highlightTimerRef.current = null;
      }, 1500);
    });

    return () => cancelAnimationFrame(frameId);
  }, [panelHighlightRequest]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    latestTaskIdRef.current = task?.id ?? null;
    setMomentumTask(task);
    setIsUpdatingCompletion(false);
  }, [task]);

  const currentTask = task && momentumTask && momentumTask.id === task.id ? momentumTask : task;
  const attentionTasks = useMemo(() => currentTask ? [currentTask] : [], [currentTask]);
  const { taskSignals, activityDescriptions } = useTaskAttention(attentionTasks, sessions, isUnread, activeSessionId, readStateReady, readStateError, sessionSource);
  const completionCounts = useMemo(() => getTaskCompletionCounts({
    checklistItems,
    linkedSessions,
    pullRequests: enrichedPRs.length > 0
      ? enrichedPRs
      : (task?.pullRequests ?? []).map(() => ({ status: null })),
  }), [checklistItems, linkedSessions, enrichedPRs, task?.pullRequests]);
  const completionState = useMemo(
    () => currentTask ? getTaskCompletionState(currentTask, completionCounts, { checklistLoaded }) : null,
    [currentTask, completionCounts, checklistLoaded],
  );

  // currentTask and completionState are null exactly when task is null, so one guard narrows all three.
  if (!task || !currentTask || !completionState) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center border-r border-border bg-bg-secondary md:w-64">
        <span className={DS.text.empty}>Select a task</span>
      </div>
    );
  }
  const hasNotesSummary = Boolean(task.notes?.trim());
  const hasInstructions = Boolean(task.instructions?.trim());
  const latestHistoryEntry = historySummary?.entries[0];
  const historyTotal = historySummary?.total ?? 0;
  const openTaskOverview = () => {
    onViewDashboard?.(task.id);
  };
  const { data: sessionWorkspace } = sessionWorkspaceQuery;
  const activeWorkspacePath = sessionWorkspace?.effectiveCwd ?? activeSession?.workspace?.effectiveCwd ?? task.cwd;
  const workspaceOverridesTask = sessionWorkspace?.overridesTaskWorkspace ?? activeSession?.workspace?.overridesTaskWorkspace ?? false;
  const workspaceWarning = sessionWorkspace?.warnings?.[0];
  const workspaceStatus = sessionWorkspace?.gitStatus ?? taskGitStatus;
  const workspaceTitle = activeWorkspacePath ? getPathTail(activeWorkspacePath) : "Set workspace";
  const showWorkspaceDefault = Boolean(
    task.cwd && activeWorkspacePath && !areWorkspacePathsEqual(activeWorkspacePath, task.cwd),
  );
  const workspaceGit = describeTaskGitStatusSummary(workspaceStatus);
  const workspaceSubtitle = [
    workspaceWarning?.message ?? activeWorkspacePath ?? "Attach a project folder to this task",
    showWorkspaceDefault ? `Task default: ${task.cwd}` : null,
    workspaceGit?.summaryText,
  ].filter(Boolean).join(" · ");
  const workspaceProblem = Boolean(workspaceWarning) || sessionWorkspace?.pathState === "missing";
  const workspaceChips: TaskPanelSummaryChip[] = [
    workspaceOverridesTask ? { label: "override", tone: "warning" } : null,
    sessionWorkspace?.pathState === "missing"
      ? { label: "missing", tone: "danger" }
      : workspaceWarning ? { label: "check", tone: "warning" } : null,
    !workspaceProblem && workspaceGit
      ? { label: `${workspaceGit.branch} · ${workspaceGit.stateLabel}` }
      : null,
  ].filter((chip): chip is TaskPanelSummaryChip => chip !== null);
  const agentSetupSummary: Array<{ label: string; tone?: "warning" | "danger" }> = [
    hasInstructions ? { label: "Instructions" } : null,
    task.playbook ? { label: task.playbook } : null,
    workspaceProblem
      ? { label: sessionWorkspace?.pathState === "missing" ? "Workspace missing" : "Workspace needs a look", tone: sessionWorkspace?.pathState === "missing" ? "danger" as const : "warning" as const }
      : activeWorkspacePath ? { label: workspaceTitle } : null,
    historyTotal > 0 ? { label: `${historyTotal} history ${historyTotal === 1 ? "entry" : "entries"}` } : null,
  ].filter((part): part is { label: string; tone?: "warning" | "danger" } => part !== null);
  const toggleAgentSetup = (expanded: boolean) => {
    setTaskPanelAgentSetupExpanded(expanded);
    setAgentSetupExpanded(expanded);
  };
  const hasLinked = (!pageInStatus && Boolean(pageQuery.data)) || task.workItems.length > 0 || task.pullRequests.length > 0
    || relatedDocs.length > 0 || sched.schedules.length > 0;
  const showChecklistComposer = checklistItems.some((item) => !item.done) || checklistComposerOpen;
  const attention = taskSignals.get(task.id);

  const showCompletionButton = currentTask.kind !== "ongoing"
    && Boolean(completionState.ctaNextStatus || completionState.ctaCompletionAction);
  const completionDisabled = !showCompletionButton || isUpdatingCompletion;
  const showMomentumFields = completionState.ctaState !== "archived";
  // Reopening depends only on the task, so it sits in the header. Completing depends on the checklist,
  // chats and pull requests, so it closes the checklist, below the chats, where its arrival moves nothing.
  const showReopen = showCompletionButton && completionState.ctaState === "completed";
  const showCompletionFooter = currentTask.kind !== "ongoing"
    && (completionState.ctaState === "ready" || completionState.ctaState === "default");
  // Ready: the finish line, when there is one. Not ready: what still stands in the way.
  const completionFooterNote = completionState.ctaState === "ready"
    ? currentTask.doneWhen?.trim() || undefined
    : completionState.ctaDescription;
  const hasHeaderMeta = currentTask.kind === "ongoing" || Boolean(group) || effectiveTags.length > 0;
  const tagPicker = onSetTaskTags ? (
    <TagPicker
      selectedTagIds={taskOwnTags.map((tag) => tag.id)}
      inheritedTagIds={inheritedTagIds}
      onChange={(tagIds) => onSetTaskTags(task.id, tagIds)}
      compact
      touch
    />
  ) : null;
  const statusLine = attention
    ? <TaskAttentionBadge signal={attention} icon />
    : completionState.ctaState === "completed" ? "Completed"
      : currentTask.status === "archived" ? "Archived"
        : currentTask.deferred ? "Set aside"
          : activityDescriptions.get(task.id);
  const handleCompletionAction = async () => {
    if (completionDisabled) return;
    const requestedTaskId = task.id;

    setIsUpdatingCompletion(true);
    try {
      const updated = await onUpdateTask(
        requestedTaskId,
        completionState.ctaCompletionAction
          ? { completionAction: completionState.ctaCompletionAction }
          : { status: completionState.ctaNextStatus! },
      );
      if (updated && latestTaskIdRef.current === requestedTaskId) {
        setMomentumTask(updated);
      }
    } finally {
      if (latestTaskIdRef.current === requestedTaskId) {
        setIsUpdatingCompletion(false);
      }
    }
  };

  const notesRow = hasNotesSummary ? (
    <TaskNotesSection
      notes={task.notes || undefined}
      onView={notes.openToView}
      onEdit={notes.openToEdit}
      variant="summary"
    />
  ) : null;

  return (
    <div className={cx(DS.surface.pane, "relative min-h-0 min-w-0 flex-1")}>
      <PullToRefresh
        onRefresh={async () => { await Promise.all([refresh(), onRefresh?.()]); }}
        className="absolute inset-0 overflow-x-hidden"
        scrollRestoration={scrollRestoration}
      >
        <div className="mx-auto w-full max-w-3xl">
        <header className="space-y-1 px-4 pb-1 pt-4">
          <div className="flex items-start gap-1">
            {onViewDashboard ? (
              <button
                type="button"
                onClick={openTaskOverview}
                aria-label={`Open overview for ${task.title}`}
                className={cx(DS.text.title, "block min-w-0 flex-1 rounded text-left hover:underline hover:decoration-text-faint hover:underline-offset-4", DS.focus)}
                title="Open task overview"
              >
                <span className="line-clamp-3">{task.title}</span>
              </button>
            ) : (
              <h1 className={cx(DS.text.title, "line-clamp-3 min-w-0 flex-1")}>{task.title}</h1>
            )}
            <IconButton
              label="Task actions"
              size="md"
              className="-mr-2 -mt-1.5"
              aria-haspopup="menu"
              aria-expanded={taskMenuPosition !== null}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setTaskMenuPosition({ x: Math.max(8, rect.right - 220), y: rect.bottom + 4 });
              }}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </IconButton>
          </div>

          {/* One fixed-height line, so a badge arriving with the read state never moves what follows. */}
          <div className="flex h-6 min-w-0 items-center gap-2">
            <div data-testid="task-status-line" className={cx(DS.text.meta, "flex min-w-0 items-center truncate")}>
              {statusLine}
            </div>
            {!hasHeaderMeta && tagPicker}
          </div>

          {hasHeaderMeta && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <TaskKindBadge kind={currentTask.kind} />
            {group && (
              <div className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted" title={`Group: ${group.name}`}>
                <IdentitySwatch color={group.color} />
                <span className="max-w-[140px] truncate">{group.name}</span>
              </div>
            )}
            {(effectiveTags.length > 0 || tagPicker) && (
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {/* Tags are removed from the picker, not with a tiny inline ×. */}
                <TagPillList
                  tags={effectiveTags}
                  inheritedTagIds={inheritedTagIds}
                  max={3}
                />
                {tagPicker}
              </div>
            )}
          </div>
          )}

          {showReopen && (
            <div className="pt-2">
              <Button
                size="sm"
                onClick={() => { void handleCompletionAction(); }}
                disabled={completionDisabled}
                title={completionState.ctaDescription}
                icon={<RotateCcw size={13} aria-hidden="true" />}
              >
                {completionState.ctaLabel}
              </Button>
            </div>
          )}
        </header>

        <div className="space-y-3 px-3 pb-6 pt-2">
          {showMomentumFields && currentTask && (
            <RevisitPrompt
              task={currentTask}
              onSaved={(updated) => {
                setMomentumTask(updated);
                void onTasksChanged?.();
              }}
            />
          )}
          {showMomentumFields ? (
            <TaskMomentumFields
              task={currentTask}
              onPatched={setMomentumTask}
              onSaved={() => {
                void onTasksChanged?.();
              }}
            >
              {notesRow && <div className="@container/task-details">{notesRow}</div>}
              <TaskPageSlot taskId={task.id} taskTitle={currentTask.title} onMakePage={() => startPage(task.id)} />
            </TaskMomentumFields>
          ) : notesRow ? (
            <Section label="Status" surface>
              <div className="@container/task-details">{notesRow}</div>
            </Section>
          ) : null}

          <Section
            surface
            label="Chats"
            count={activeLinkedSessionCount}
            action={(
              <Button
                size="sm"
                variant="ghost"
                className="-mr-2"
                icon={<Plus size={13} aria-hidden="true" />}
                onClick={() => onNewSession(task.id)}
              >
                New chat
              </Button>
            )}
          >
            <TaskSessionList
              task={task}
              linkedSessions={linkedSessions}
              activeSessionId={activeSessionId}
              onSelectSession={onSelectSession}
              onNewSession={onNewSession}
              showEmptyState={activeLinkedSessionCount === 0}
              isUnread={isUnread}
              onArchiveSession={onArchiveSession}
              archivingIds={archivingIds}
              exitingIds={exitingIds}
              onUnlinkFromTask={onUnlinkFromTask}
              onTasksChanged={onTasksChanged}
              onDeleteSession={onDeleteSession}
              onForkSession={onForkSession}
              onReloadSession={onReloadSession}
              onMarkUnread={onMarkUnread}
              onBulkAction={onBulkAction}
              hasDraft={hasDraft}
              showNewButton={false}
              activeLimit={TASK_PANEL_CHAT_LIMIT}
              className="-mx-3 min-w-0 overflow-x-hidden"
            />
          </Section>

          <div
            data-testid="task-panel-lower"
            aria-busy={!lowerRevealed || undefined}
            className={cx("space-y-3", !lowerRevealed && "invisible")}
          >
          <Section
            surface
            label="Checklist"
            count={checklistItems.length > 0
              ? `${checklistItems.filter((item) => item.done).length}/${checklistItems.length}`
              : undefined}
            action={showChecklistComposer ? undefined : (
              <Button
                size="sm"
                variant="ghost"
                className="-mr-2"
                icon={<Plus size={13} aria-hidden="true" />}
                onClick={() => setChecklistComposerOpen(true)}
              >
                Add
              </Button>
            )}
          >
            <TaskChecklistSection
              taskId={task.id}
              checklistItems={checklistItems}
              newChecklistItemText={newChecklistItemText}
              onNewChecklistItemTextChange={setNewChecklistItemText}
              onCreateChecklistItem={async (text, deadline) => { await createChecklistItemMutation.mutateAsync({ text, deadline }); }}
              onChecklistItemUpdate={onChecklistItemUpdate}
              onChecklistItemDelete={(id) => onChecklistItemDelete(id)}
              variant="panel"
              highlightId={highlightChecklistItemId}
              isReadyToComplete={currentTask.kind !== "ongoing" && completionState.isReadyToComplete}
              showComposer={showChecklistComposer}
              onComposerDone={() => setChecklistComposerOpen(false)}
            />
            {showCompletionFooter && (
              <div className={cx("flex min-w-0 items-center gap-3", checklistItems.length > 0 && "mt-2 border-t border-surface-edge pt-2.5")}>
                {showCompletionButton && (
                  <Button
                    size="sm"
                    onClick={() => { void handleCompletionAction(); }}
                    disabled={completionDisabled}
                    icon={<CheckCircle2 size={13} aria-hidden="true" />}
                  >
                    {completionState.ctaLabel}
                  </Button>
                )}
                {completionFooterNote && (
                  <p className={cx(DS.text.meta, "min-w-0 flex-1 truncate")} title={completionFooterNote}>
                    {completionFooterNote}
                  </p>
                )}
              </div>
            )}
          </Section>

          <TaskDatesSection taskId={task.id} />

          {startersShown && onStartSuggestedChat && (
            <TaskStartersSection
              taskId={task.id}
              onStart={(starter) => onStartSuggestedChat(task.id, starter)}
            />
          )}

          {hasLinked && (
            <Section label="Linked" surface>
              <div className="@container/task-details space-y-0.5">
                {!pageInStatus && <TaskPageSection taskId={task.id} taskTitle={currentTask.title} />}
                {task.workItems.length > 0 && (
                  <WorkItemList
                    enrichedWIs={enrichedWIs}
                    rawWIs={task.workItems}
                    variant="summary"
                    taskId={task.id}
                    onTasksChanged={onTasksChanged}
                  />
                )}
                {task.pullRequests.length > 0 && (
                  <PullRequestList
                    enrichedPRs={enrichedPRs}
                    rawPRs={task.pullRequests}
                    variant="summary"
                    taskId={task.id}
                    onTasksChanged={onTasksChanged}
                  />
                )}
                {relatedDocs.length > 0 && (
                  <RelatedDocsSection
                    docs={relatedDocs}
                    variant="summary"
                    onPreview={(path) => setPreviewDocPath(path)}
                    taskId={task.id}
                  />
                )}
                {sched.schedules.length > 0 && (
                  <ScheduleSection
                    schedules={sched.schedules}
                    variant="summary"
                    taskId={task.id}
                    onAdd={() => schedDetail.openForCreate(task.id)}
                    onOpen={(schedule) => schedDetail.openSheet(schedule)}
                    onTrigger={(id) => sched.trigger(id)}
                    onToggle={(schedule) => sched.toggle(schedule)}
                    onEdit={(schedule) => schedDetail.openSheet(schedule, "edit")}
                    onDelete={(id) => sched.remove(id)}
                  />
                )}
              </div>
            </Section>
          )}

          <Section
            label="Agent setup"
            surface
            action={agentSetupExpanded ? (
              <Button size="sm" variant="ghost" className="-mr-2" aria-expanded onClick={() => toggleAgentSetup(false)}>
                Hide
              </Button>
            ) : undefined}
          >
            {!agentSetupExpanded ? (
              <button
                type="button"
                aria-expanded={false}
                onClick={() => toggleAgentSetup(true)}
                title={agentSetupSummary.map((part) => part.label).join(" · ")}
                className={cx(DS.row.base, DS.row.touch, DS.row.interactive)}
              >
                <span className="min-w-0 flex-1 truncate text-text-secondary">
                  {agentSetupSummary.length > 0 ? agentSetupSummary.map((part, index) => (
                    <span key={part.label} className={part.tone ? DS.tone[part.tone] : undefined}>
                      {index > 0 && " · "}
                      {part.label}
                    </span>
                  )) : "Instructions, playbook, workspace"}
                </span>
                <ChevronRight size={12} aria-hidden="true" className={DS.row.chevron} />
              </button>
            ) : (
              <div className="@container/task-details space-y-0.5">
                <TaskNotesSection
                  notes={task.instructions || undefined}
                  onView={instructionsSheet.openToView}
                  onEdit={instructionsSheet.openToEdit}
                  variant="summary"
                  label="Instructions"
                  icon={<ScrollText size={14} />}
                  emptyTitle="Add standing rules for agents"
                />
                <TaskPlaybookRow task={task} onTasksChanged={onTasksChanged} />
                <TaskPanelSummaryRow
                  label="Workspace"
                  icon={workspaceProblem
                    ? <AlertTriangle size={14} className={sessionWorkspace?.pathState === "missing" ? "text-error" : "text-warning"} />
                    : <FolderOpen size={14} />}
                  title={workspaceTitle}
                  subtitle={workspaceSubtitle}
                  chips={workspaceChips}
                  onClick={openWorkspaceSheet}
                />
                <TaskPanelSummaryRow
                  label="History"
                  icon={<History size={14} />}
                  title={latestHistoryEntry ? latestHistoryEntry.text : "Nothing recorded yet"}
                  subtitle={latestHistoryEntry ? `${describeHistoryActor(latestHistoryEntry)} · ${new Date(latestHistoryEntry.at).toLocaleString()}` : undefined}
                  placeholder={!latestHistoryEntry}
                  chips={historyTotal > 0 ? [{ label: String(historyTotal) }] : []}
                  onClick={historySheet.openToView}
                />
                <TaskMomentumHistory taskId={task.id} onSelectSession={onSelectSession} />
              </div>
            )}
          </Section>
          </div>

          {schedDetail.isOpen && (
            <ScheduleDetailSheet
              schedule={schedDetail.schedule}
              taskId={task.id}
              taskTitle={task.title}
              mode={schedDetail.mode}
              onClose={schedDetail.close}
              onSwitchToEdit={schedDetail.switchToEdit}
              onSwitchToView={schedDetail.switchToView}
              onTrigger={sched.trigger}
              onToggle={sched.toggle}
              onDelete={sched.remove}
              onSaved={() => {
                schedDetail.close();
                sched.reload();
              }}
              onSelectSession={onSelectSession}
            />
          )}

          {previewDocPath && (
            <DocPreviewSheet
              docPath={previewDocPath}
              onClose={() => setPreviewDocPath(null)}
            />
          )}

          {instructionsSheet.notesSheetOpen && (
            <NotesSheet
              notes={task.instructions ?? ""}
              startInEditMode={instructionsSheet.notesStartEdit}
              title="Instructions"
              icon={<ScrollText size={14} className="text-text-muted" />}
              description="Part of every session's system prompt."
              placeholder="Rules for agents working on this task, in markdown..."
              emptyMessage="No instructions yet"
              emptyActionLabel="Add instructions"
              onSave={async (next) => {
                await patchTask(task.id, { instructions: next });
                onTasksChanged?.();
              }}
              onClose={instructionsSheet.close}
            />
          )}
          {historySheet.notesSheetOpen && (
            <TaskHistorySheet
              taskId={task.id}
              onClose={historySheet.close}
              onSelectSession={(sessionId) => {
                historySheet.close();
                onSelectSession(sessionId);
              }}
            />
          )}
          {notes.notesSheetOpen && (
            <NotesSheet
              notes={task.notes}
              startInEditMode={notes.notesStartEdit}
              onSave={async (newNotes) => {
                await patchTask(task.id, { notes: newNotes });
                onTasksChanged?.();
              }}
              onClose={notes.close}
            />
          )}
          {workspaceSheetOpen && (
            <WorkspaceDetailsSheet
              task={task}
              session={activeSession}
              taskGitStatus={taskGitStatus}
              onClose={() => setWorkspaceSheetOpen(false)}
              onTaskUpdated={onTasksChanged}
            />
          )}
          {taskMenuPosition && (
            <TaskContextMenu
              task={currentTask}
              position={taskMenuPosition}
              taskGroups={taskGroups}
              sessionMap={sessionMap}
              isUnread={isUnread}
              activeSessionId={activeSessionId}
              actions={{
                onUpdateTask: (taskId, updates) => { void onUpdateTask(taskId, updates); },
                onDeleteTask,
                onMoveTaskToGroup,
              }}
              onClose={() => setTaskMenuPosition(null)}
              renderLeadingItems={(closeMenu) => (
                <>
                  {onViewDashboard && (
                    <CtxItem
                      icon={<LayoutDashboard size={14} />}
                      label="Open task overview"
                      onClick={() => { closeMenu(); openTaskOverview(); }}
                    />
                  )}
                  <CtxItem
                    icon={<Sparkles size={14} />}
                    label="Tidy instructions and notes"
                    onClick={() => { closeMenu(); void startTidy(currentTask.id); }}
                  />
                  <RemoveTaskPageItem taskId={currentTask.id} closeMenu={closeMenu} />
                </>
              )}
            />
          )}
        </div>
        </div>
      </PullToRefresh>
    </div>
  );
}
