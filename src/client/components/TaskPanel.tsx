import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Task, TaskGroup, Session } from "../api";
import { fetchTaskGitStatus, patchTask } from "../api";
import { useTaskWorkspace } from "../hooks/useTaskWorkspace";
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
} from "lucide-react";
import DocPreviewSheet from "./DocPreviewSheet";
import TaskMomentumFields from "./TaskMomentumFields";
import TaskMomentumHistory from "./TaskMomentumHistory";
import TaskPanelSummaryRow, { type TaskPanelSummaryChip } from "./TaskPanelSummaryRow";
import { describeTaskGitStatusSummary } from "../lib/task-git-status-summary";
import { getTaskPanelDetailsExpanded, setTaskPanelDetailsExpanded } from "../task-panel-disclosure-state";
import { TaskContextMenu } from "./task-list";
import { CtxItem } from "./ContextMenu";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";
import { getTaskAlertChips, type TaskAlertTone } from "./task-momentum-alerts";
import { LoadingSkeletonRegion, Skeleton, SkeletonRow, SkeletonText } from "./shared/Skeleton";
import { DS, cx } from "../design/tokens";
import { Badge, Button, IconButton, Section, IdentitySwatch } from "../design/primitives";
import {
  AgentDefinitionsSection,
  WorkItemList,
  PullRequestList,
  TaskChecklistSection,
  TaskNotesSection,
  RelatedDocsSection,
  ScheduleSection,
} from "./task-sections";
import AgentDefinitionPreviewSheet from "./AgentDefinitionPreviewSheet";
import type { TaskAgentDefinitionSummary } from "../api";


function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

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
  onUpdateTask: (
    taskId: string,
    updates: Parameters<typeof patchTask>[1],
  ) => Promise<Task | null>;
  onTasksChanged?: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
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
  onUpdateTask,
  onTasksChanged,
  isUnread,
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
  const ws = useTaskWorkspace(task ?? undefined, taskGroups, sessions);
  const {
    enrichedWIs,
    enrichedPRs,
    sched,
    schedDetail,
    notes,
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
    agentDefinitions,
    refresh,
  } = ws;
  const activeSession = linkedSessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const sessionWorkspaceQuery = useSessionWorkspaceQuery(activeSession?.sessionId, task?.id);

  const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const [previewAgentDefinition, setPreviewAgentDefinition] = useState<TaskAgentDefinitionSummary | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightChecklistItemId, setHighlightChecklistItemId] = useState<string | null>(null);
  const [panelHighlightRequest, setPanelHighlightRequest] = useState<{ highlightId: string | null } | null>(null);
  const [momentumTask, setMomentumTask] = useState(task);
  const [isUpdatingCompletion, setIsUpdatingCompletion] = useState(false);
  const [taskMenuPosition, setTaskMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [checklistComposerOpen, setChecklistComposerOpen] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(getTaskPanelDetailsExpanded);
  const sessionMap = useMemo(() => new Map(sessions.map((session) => [session.sessionId, session])), [sessions]);
  const activeLinkedSessionCount = linkedSessions.filter((session) => !session.archived).length;
  const highlightTimerRef = useRef<number | null>(null);
  const latestTaskIdRef = useRef(task?.id ?? null);
  const pendingChecklistItemId = searchParams.get("checklistItem");

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

    if (!pendingChecklistItemId || !resolvedHighlight.consumeParam) return;

    setPanelHighlightRequest({ highlightId: resolvedHighlight.highlightId });
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("checklistItem");
      return next;
    }, { replace: true });
  }, [checklistItems, checklistItemsReady, pendingChecklistItemId, setSearchParams]);

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
  const alertChips = useMemo(() => {
    if (!currentTask) return [];
    return getTaskAlertChips({
      task: currentTask,
      pullRequests: enrichedPRs,
    });
  }, [currentTask, enrichedPRs]);

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
  const detailsSummary: Array<{ label: string; tone?: "warning" | "danger" }> = [
    task.workItems.length > 0 ? { label: pluralize(task.workItems.length, "work item") } : null,
    task.pullRequests.length > 0 ? { label: pluralize(task.pullRequests.length, "PR") } : null,
    hasNotesSummary ? { label: "notes" } : null,
    relatedDocs.length > 0 ? { label: pluralize(relatedDocs.length, "doc") } : null,
    agentDefinitions.length > 0 ? { label: pluralize(agentDefinitions.length, "agent") } : null,
    sched.schedules.length > 0 ? { label: pluralize(sched.schedules.length, "schedule") } : null,
    workspaceProblem
      ? { label: sessionWorkspace?.pathState === "missing" ? "workspace missing" : "workspace needs a look", tone: sessionWorkspace?.pathState === "missing" ? "danger" as const : "warning" as const }
      : activeWorkspacePath
        ? { label: workspaceGit ? `${workspaceTitle} · ${workspaceGit.branch}` : workspaceTitle }
        : { label: "no workspace" },
  ].filter((part): part is { label: string; tone?: "warning" | "danger" } => part !== null);
  const toggleDetails = (expanded: boolean) => {
    setTaskPanelDetailsExpanded(expanded);
    setDetailsExpanded(expanded);
  };
  const showChecklistComposer = checklistItems.some((item) => !item.done) || checklistComposerOpen;

  const showCompletionButton = currentTask.kind !== "ongoing"
    && Boolean(completionState.ctaNextStatus || completionState.ctaCompletionAction);
  const completionDisabled = !showCompletionButton || isUpdatingCompletion;
  // An ongoing task's kind badge already says it has no finish line, so it gets no note.
  const completionDescription = currentTask.kind === "ongoing"
    ? undefined
    : completionState.ctaDescription;
  const showMomentumFields = completionState.ctaState !== "archived";
  const completionNote = completionState.ctaState !== "archived" ? completionDescription : undefined;
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

  return (
    <div className={cx(DS.surface.pane, "relative min-h-0 min-w-0 flex-1")}>
      <PullToRefresh
        onRefresh={async () => { await Promise.all([refresh(), onRefresh?.()]); }}
        className="absolute inset-0 overflow-x-hidden"
        scrollRestoration={scrollRestoration}
      >
        <div className="mx-auto w-full max-w-3xl">
        <div className={cx(DS.surface.group, "mx-3 mt-3 space-y-2 p-3")}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1 space-y-1.5">
            {onViewDashboard ? (
              <button
                type="button"
                onClick={openTaskOverview}
                aria-label={`Open overview for ${task.title}`}
                className={cx(DS.text.title, "block min-w-0 rounded text-left hover:underline hover:decoration-text-faint hover:underline-offset-4", DS.focus)}
                title="Open task overview"
              >
                <span className="line-clamp-3">{task.title}</span>
              </button>
            ) : (
              <h1 className={cx(DS.text.title, "line-clamp-3")}>{task.title}</h1>
            )}

            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <TaskKindBadge kind={currentTask.kind} showTask />
              {group && (
                <div className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted" title={`Group: ${group.name}`}>
                  <IdentitySwatch color={group.color} />
                  <span className="max-w-[112px] truncate">{group.name}</span>
                </div>
              )}
              {(effectiveTags.length > 0 || onSetTaskTags) && (
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  {/* Tags are removed from the picker, not with a tiny inline ×. */}
                  <TagPillList
                    tags={effectiveTags}
                    inheritedTagIds={inheritedTagIds}
                    max={3}
                  />
                  {onSetTaskTags && (
                    <TagPicker
                      selectedTagIds={taskOwnTags.map((tag) => tag.id)}
                      inheritedTagIds={inheritedTagIds}
                      onChange={(tagIds) => onSetTaskTags(task.id, tagIds)}
                      compact
                      touch
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          <IconButton
            label="Task actions"
            className="-mr-1.5 -mt-1.5 md:-mt-0.5"
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

        {alertChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {alertChips.map((chip) => (
              <Badge key={chip.kind} tone={ALERT_BADGE_TONE[chip.tone]} title={chip.title}>
                {chip.label}
              </Badge>
            ))}
          </div>
        )}

        {showCompletionButton && (
          <div className="space-y-2 pt-1">
            <Button
              fullWidth
              onClick={() => { void handleCompletionAction(); }}
              disabled={completionDisabled}
              title={completionDescription}
              icon={completionState.ctaState === "completed"
                ? <RotateCcw size={13} aria-hidden="true" />
                : <CheckCircle2 size={13} aria-hidden="true" />}
            >
              {completionState.ctaLabel}
            </Button>
            {completionDescription && (
              <p className="text-xs leading-relaxed text-text-muted">
                {completionDescription}
              </p>
            )}
          </div>
        )}
        {!showCompletionButton && completionNote && (
          <p className="text-xs leading-relaxed text-text-muted">{completionNote}</p>
        )}
      </div>

        <div className="space-y-3 px-3 pb-6 pt-3">
          {showMomentumFields ? (
            <TaskMomentumFields
              task={currentTask}
              onPatched={setMomentumTask}
              onSelectSession={onSelectSession}
              onSaved={() => {
                void onTasksChanged?.();
              }}
            />
          ) : (
            <TaskMomentumHistory taskId={task.id} onSelectSession={onSelectSession} standalone />
          )}

          <Section
            surface
            label="Sessions"
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
              className="-mx-3 min-w-0 overflow-x-hidden"
            />
          </Section>

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
              onCreateChecklistItem={async (text) => { await createChecklistItemMutation.mutateAsync({ text }); }}
              onChecklistItemUpdate={onChecklistItemUpdate}
              onChecklistItemDelete={(id) => onChecklistItemDelete(id)}
              variant="panel"
              highlightId={highlightChecklistItemId}
              isReadyToComplete={currentTask.kind !== "ongoing" && completionState.isReadyToComplete}
              showComposer={showChecklistComposer}
              onComposerDone={() => setChecklistComposerOpen(false)}
            />
          </Section>

          <Section
            label="Details"
            surface
            action={detailsExpanded ? (
              <Button size="sm" variant="ghost" className="-mr-2" aria-expanded onClick={() => toggleDetails(false)}>
                Hide
              </Button>
            ) : undefined}
          >
            {!detailsExpanded ? (
              <button
                type="button"
                aria-expanded={false}
                onClick={() => toggleDetails(true)}
                title={detailsSummary.map((part) => part.label).join(" · ")}
                className={cx(DS.row.base, DS.row.touch, DS.row.interactive)}
              >
                <span className="min-w-0 flex-1 truncate text-text-secondary">
                  {detailsSummary.map((part, index) => (
                    <span key={part.label} className={part.tone ? DS.tone[part.tone] : undefined}>
                      {index > 0 && " · "}
                      {part.label}
                    </span>
                  ))}
                </span>
                <ChevronRight size={12} aria-hidden="true" className={DS.row.chevron} />
              </button>
            ) : (
              <div className="@container/task-details space-y-0.5">
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
                {hasNotesSummary && (
                  <TaskNotesSection
                    notes={task.notes || undefined}
                    onView={notes.openToView}
                    onEdit={notes.openToEdit}
                    variant="summary"
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
                {agentDefinitions.length > 0 && (
                  <AgentDefinitionsSection
                    taskId={task.id}
                    definitions={agentDefinitions}
                    onPreview={setPreviewAgentDefinition}
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
              </div>
            )}
          </Section>

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
          {previewAgentDefinition && (
            <AgentDefinitionPreviewSheet
              taskId={task.id}
              definition={previewAgentDefinition}
              onClose={() => setPreviewAgentDefinition(null)}
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
              renderLeadingItems={onViewDashboard ? (closeMenu) => (
                <CtxItem
                  icon={<LayoutDashboard size={14} />}
                  label="Open task overview"
                  onClick={() => { closeMenu(); openTaskOverview(); }}
                />
              ) : undefined}
            />
          )}
        </div>
        </div>
      </PullToRefresh>
    </div>
  );
}

const ALERT_BADGE_TONE: Record<TaskAlertTone, "accent" | "info" | "success" | "warning" | "danger" | "neutral"> = {
  neutral: "neutral",
  accent: "accent",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
};
