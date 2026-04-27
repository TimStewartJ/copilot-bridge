import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Task, TaskGroup, Session } from "../api";
import { patchTask } from "../api";
import { GROUP_COLOR_DOT } from "../group-colors";
import { useTaskWorkspace } from "../hooks/useTaskWorkspace";
import { useSessionWorkspaceQuery } from "../hooks/queries/useSessionWorkspace";
import { getTaskCompletionCounts, getTaskCompletionState } from "../task-completion-helpers";
import { areWorkspacePathsEqual } from "../lib/workspace-presentation";
import {
  resolveTaskPanelChecklistHighlight,
  type TaskDashboardNavigationOptions,
} from "../task-detail-focus";
import {
  getTaskPanelChecklistPreview,
} from "../task-panel-preview";
import TaskSessionList from "./TaskSessionList";
import PullToRefresh from "./PullToRefresh";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import NotesSheet from "./NotesSheet";
import { TagPillList } from "./TagPill";
import TagPicker from "./TagPicker";
import {
  FolderOpen,
  LayoutDashboard,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import DocPreviewSheet from "./DocPreviewSheet";
import TaskMomentumFields from "./TaskMomentumFields";
import TaskKindSwitcher from "./TaskKindSwitcher";
import TaskPanelSummaryRow from "./TaskPanelSummaryRow";
import TaskGitStatusSummary from "./TaskGitStatusSummary";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";
import { getTaskAlertChips, type TaskAlertTone } from "./task-momentum-alerts";
import { getTaskKindUpdate } from "../task-kind";
import {
  WorkItemList,
  PullRequestList,
  TaskChecklistSection,
  TaskNotesSection,
  RelatedDocsSection,
  ScheduleSection,
} from "./task-sections";

function SectionLabel({ label, count, progress }: { label: string; count?: number; progress?: string }) {
  return (
    <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
      {label}
      {progress !== undefined && (
        <span className="ml-1 text-text-faint">({progress})</span>
      )}
      {progress === undefined && count !== undefined && (
        <span className="ml-1 text-text-faint">({count})</span>
      )}
    </div>
  );
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
  onDuplicateSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  hasDraft?: (sessionId: string) => boolean;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onRefresh?: () => Promise<void>;
  onViewDashboard?: (taskId: string, options?: TaskDashboardNavigationOptions) => void;
  onMarkAllRead?: () => void;
  onBulkAction?: (action: import("../api").BatchAction, sessionIds: string[]) => void;
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
  onSetTaskTags?: (taskId: string, tagIds: string[]) => void;
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
  onDuplicateSession,
  onReloadSession,
  onMarkUnread,
  hasDraft,
  onMoveTaskToGroup,
  onRefresh,
  onViewDashboard,
  onMarkAllRead,
  onBulkAction,
  onRequestArchived,
  archivedLoaded,
  archivedLoading,
  onSetTaskTags,
}: TaskPanelProps) {
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
    refresh,
  } = ws;
  const activeSession = linkedSessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const sessionWorkspaceQuery = useSessionWorkspaceQuery(activeSession?.sessionId, task?.id);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightChecklistItemId, setHighlightChecklistItemId] = useState<string | null>(null);
  const [hasChecklistHandoff, setHasChecklistHandoff] = useState(false);
  const [handoffChecklistItemId, setHandoffChecklistItemId] = useState<string | null>(null);
  const [panelHighlightRequest, setPanelHighlightRequest] = useState<{ highlightId: string | null } | null>(null);
  const [momentumTask, setMomentumTask] = useState(task);
  const [isUpdatingCompletion, setIsUpdatingCompletion] = useState(false);
  const highlightTimerRef = useRef<number | null>(null);
  const latestTaskIdRef = useRef(task?.id ?? null);
  const pendingChecklistItemId = searchParams.get("checklistItem");

  useEffect(() => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setEditingTitle(false);
    setPreviewDocPath(null);
    setWorkspaceSheetOpen(false);
    setHighlightChecklistItemId(null);
    setHasChecklistHandoff(false);
    setHandoffChecklistItemId(null);
    setPanelHighlightRequest(null);
  }, [task?.id]);

  useEffect(() => {
    const resolvedHighlight = resolveTaskPanelChecklistHighlight({
      focusedChecklistItemId: pendingChecklistItemId,
      checklistItems,
      checklistItemsReady,
    });

    if (!pendingChecklistItemId || !resolvedHighlight.consumeParam) return;

    setHasChecklistHandoff(true);
    setHandoffChecklistItemId(resolvedHighlight.highlightId);
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
      sessions: linkedSessions,
      activeSessionId,
      isUnread,
      pullRequests: enrichedPRs,
    });
  }, [activeSessionId, currentTask, enrichedPRs, isUnread, linkedSessions]);

  const checklistPreview = useMemo(
    () => getTaskPanelChecklistPreview(checklistItems, { highlightId: highlightChecklistItemId }),
    [checklistItems, highlightChecklistItemId],
  );
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

  if (!task) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center border-r border-border bg-bg-secondary md:w-64">
        <span className="text-xs text-text-faint">Select a task</span>
      </div>
    );
  }
  const checklistSummary = [
    checklistPreview.overdueCount > 0
      ? { label: `${checklistPreview.overdueCount} overdue`, className: "text-error" }
      : null,
    checklistPreview.dueSoonCount > 0
      ? { label: `${checklistPreview.dueSoonCount} due soon`, className: "text-warning" }
      : null,
    checklistPreview.openCount > 0
      ? { label: `${checklistPreview.openCount} open`, className: "text-text-faint" }
      : null,
    checklistPreview.completedCount > 0
      ? { label: `${checklistPreview.completedCount} done`, className: "text-text-faint" }
      : null,
  ].filter((item): item is { label: string; className: string } => item !== null);

  const hasNotesSummary = Boolean(task.notes?.trim());
  const openTaskOverview = (section?: "sessions" | "checklist") => {
    const checklistItemId = section === "sessions"
      ? undefined
      : pendingChecklistItemId ?? handoffChecklistItemId ?? highlightChecklistItemId ?? undefined;
    const nextSection = section ?? (checklistItemId || hasChecklistHandoff ? "checklist" : undefined);
    const options = nextSection || checklistItemId
      ? { section: nextSection, checklistItemId }
      : undefined;
    onViewDashboard?.(task.id, options);
  };
  const { data: sessionWorkspace } = sessionWorkspaceQuery;
  const activeWorkspacePath = sessionWorkspace?.effectiveCwd ?? activeSession?.workspace?.effectiveCwd ?? task.cwd;
  const workspaceOverridesTask = sessionWorkspace?.overridesTaskWorkspace ?? activeSession?.workspace?.overridesTaskWorkspace ?? false;
  const workspaceWarning = sessionWorkspace?.warnings?.[0];
  const workspaceStatus = sessionWorkspace?.gitStatus ?? taskGitStatus;
  const workspaceTitle = activeWorkspacePath ? getPathTail(activeWorkspacePath) : "Set workspace";
  const workspaceSubtitle = workspaceWarning?.message
    ?? activeWorkspacePath
    ?? "Attach a project folder to this task";
  const workspaceChips = [
    workspaceOverridesTask
      ? { label: "override", className: "bg-warning/15 text-warning" }
      : null,
    sessionWorkspace?.pathState === "missing"
      ? { label: "missing", className: "bg-error/15 text-error" }
      : null,
  ].filter((item): item is { label: string; className: string } => item !== null);
  const showWorkspaceDefault = Boolean(
    task.cwd && activeWorkspacePath && !areWorkspacePathsEqual(activeWorkspacePath, task.cwd),
  );
  const showSecondarySummaries = true;

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdateTask(task.id, { title: trimmed });
    }
    setEditingTitle(false);
  };

  const handleKindChange = (nextKind: Task["kind"]) => {
    const updates = getTaskKindUpdate(currentTask, nextKind);
    if (!updates) return;
    void onUpdateTask(task.id, updates);
  };
  const showCompletionButton = currentTask.kind !== "ongoing"
    && Boolean(completionState.ctaNextStatus || completionState.ctaCompletionAction);
  const completionDisabled = !showCompletionButton || isUpdatingCompletion;
  const completionDescription = currentTask.kind === "ongoing"
    ? "Ongoing tasks stay active and cannot be completed."
    : completionState.ctaDescription;
  const showCompletionDetails = completionState.ctaState !== "archived";
  const showMomentumFields = completionState.ctaState !== "archived";
  const showCompletionArea = showCompletionButton || showCompletionDetails || showMomentumFields;
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
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-border bg-bg-secondary md:w-64">
      <div className="space-y-2.5 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          {onViewDashboard ? (
            <button
              onClick={() => openTaskOverview()}
              className="inline-flex items-center gap-1.5 text-[10px] text-text-muted transition-colors hover:text-accent"
            >
              <LayoutDashboard size={10} />
              <span>Task Overview</span>
            </button>
          ) : <span />}
          <div className="flex shrink-0 items-center gap-1.5">
            <TaskKindSwitcher kind={currentTask.kind} onChange={handleKindChange} />
            <span className={getStatusBadgeClass(currentTask.status)}>
              {currentTask.status}
            </span>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            {editingTitle ? (
              <input
                autoFocus
                className="w-full rounded border border-border bg-bg-surface px-1.5 py-0.5 text-sm font-medium text-text-primary outline-none focus:border-accent"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
              />
            ) : (
              <button
                onClick={() => {
                  setTitleDraft(task.title);
                  setEditingTitle(true);
                }}
                className="w-full text-left text-sm font-medium leading-tight text-text-primary transition-colors hover:text-accent"
                title="Click to edit title"
              >
                <span className="line-clamp-2">{task.title}</span>
              </button>
            )}

            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {group && (
                <div className="flex shrink-0 items-center gap-1 rounded bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-muted" title={`Group: ${group.name}`}>
                  <span className={`h-2 w-2 rounded-full ${GROUP_COLOR_DOT[group.color] ?? "bg-slate-500"}`} />
                  <span className="max-w-[88px] truncate">{group.name}</span>
                </div>
              )}
              {(effectiveTags.length > 0 || onSetTaskTags) && (
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <TagPillList
                    tags={effectiveTags}
                    inheritedTagIds={inheritedTagIds}
                    onRemove={onSetTaskTags ? (tagId) => {
                      const newIds = taskOwnTags.filter((tag) => tag.id !== tagId).map((tag) => tag.id);
                      onSetTaskTags(task.id, newIds);
                    } : undefined}
                    max={3}
                  />
                  {onSetTaskTags && (
                    <TagPicker
                      selectedTagIds={taskOwnTags.map((tag) => tag.id)}
                      inheritedTagIds={inheritedTagIds}
                      onChange={(tagIds) => onSetTaskTags(task.id, tagIds)}
                      compact
                    />
                  )}
                </div>
              )}
            </div>
          </div>

        </div>

        {alertChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {alertChips.map((chip) => (
              <span
                key={chip.kind}
                className={`rounded-full px-2 py-0.5 text-[10px] ${ALERT_TONE_CLASS[chip.tone]}`}
                title={chip.title}
              >
                {chip.label}
              </span>
            ))}
          </div>
        )}

        {showCompletionArea && (
          <div className="space-y-2">
            {showCompletionButton && (
              <button
                onClick={() => { void handleCompletionAction(); }}
                disabled={completionDisabled}
                title={completionDescription}
                className="w-full px-3 py-2 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center justify-center gap-1.5 disabled:bg-bg-hover disabled:text-text-faint disabled:hover:bg-bg-hover"
              >
                {completionState.ctaState === "completed" ? <RotateCcw size={12} /> : <CheckCircle2 size={12} />}
                {completionState.ctaLabel}
              </button>
            )}
            {showCompletionDetails && (
              <p className="text-[11px] text-text-muted leading-relaxed">
                {completionDescription}
              </p>
            )}
            {showMomentumFields && (
              <TaskMomentumFields
                task={currentTask}
                onPatched={setMomentumTask}
                onSaved={() => {
                  void onTasksChanged?.();
                }}
              />
            )}
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <PullToRefresh
          onRefresh={async () => { await Promise.all([refresh(), onRefresh?.()]); }}
          className="absolute inset-0 overflow-x-hidden p-2 space-y-3"
        >
          <div>
            <SectionLabel label="Sessions" count={task.sessionIds.length} />
            <TaskSessionList
              task={task}
              linkedSessions={linkedSessions}
              activeSessionId={activeSessionId}
              onSelectSession={onSelectSession}
              onNewSession={onNewSession}
              showEmptyState={linkedSessions.length === 0}
              isUnread={isUnread}
              onArchiveSession={onArchiveSession}
              archivingIds={archivingIds}
              exitingIds={exitingIds}
              onUnlinkFromTask={onUnlinkFromTask}
              onTasksChanged={onTasksChanged}
              onDeleteSession={onDeleteSession}
              onDuplicateSession={onDuplicateSession}
              onReloadSession={onReloadSession}
              onMarkUnread={onMarkUnread}
              onBulkAction={onBulkAction}
              hasDraft={hasDraft}
              onRequestArchived={onRequestArchived}
              archivedLoaded={archivedLoaded}
              archivedLoading={archivedLoading}
            />
          </div>

          <div>
            <SectionLabel
              label="Checklist"
              count={checklistItems.length > 0 ? undefined : 0}
              progress={checklistItems.length > 0 ? `${checklistItems.filter((item) => item.done).length}/${checklistItems.length}` : undefined}
            />
            {checklistSummary.length > 0 && (
              <div className="flex flex-wrap gap-x-2 gap-y-1 px-3 pb-1 text-[10px]">
                {checklistSummary.map((item) => (
                  <span key={item.label} className={item.className}>
                    {item.label}
                  </span>
                ))}
              </div>
            )}
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
              onViewAll={onViewDashboard ? () => openTaskOverview("checklist") : undefined}
              isReadyToComplete={currentTask.kind !== "ongoing" && completionState.isReadyToComplete}
            />
          </div>

          {showSecondarySummaries && (
            <div>
              <SectionLabel label="Details" />
              <div className="space-y-1">
                {task.workItems.length > 0 && (
                  <WorkItemList
                    enrichedWIs={enrichedWIs}
                    rawWIs={task.workItems}
                    variant="summary"
                    resetKey={task.id}
                  />
                )}
                {task.pullRequests.length > 0 && (
                  <PullRequestList
                    enrichedPRs={enrichedPRs}
                    rawPRs={task.pullRequests}
                    variant="summary"
                    resetKey={task.id}
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
                    resetKey={task.id}
                  />
                )}
                {sched.schedules.length > 0 && (
                  <ScheduleSection
                    schedules={sched.schedules}
                    variant="summary"
                    resetKey={task.id}
                    onAdd={() => schedDetail.openForCreate(task.id)}
                    onOpen={(schedule) => schedDetail.openSheet(schedule)}
                    onTrigger={(id) => sched.trigger(id)}
                    onToggle={(schedule) => sched.toggle(schedule)}
                    onEdit={(schedule) => schedDetail.openSheet(schedule, "edit")}
                    onDelete={(id) => sched.remove(id)}
                  />
                )}
                <div className="space-y-1">
                  <TaskPanelSummaryRow
                    label="Workspace"
                    icon={workspaceWarning || sessionWorkspace?.pathState === "missing"
                      ? <AlertTriangle size={14} className={sessionWorkspace?.pathState === "missing" ? "text-error" : "text-warning"} />
                      : <FolderOpen size={14} />}
                    title={workspaceTitle}
                    subtitle={workspaceSubtitle}
                    subtitleClassName={workspaceWarning ? "line-clamp-2 text-warning" : "truncate font-mono"}
                    chips={workspaceChips}
                    onClick={() => setWorkspaceSheetOpen(true)}
                  />
                  {!workspaceWarning && (showWorkspaceDefault || workspaceStatus) && (
                    <div className="rounded-md bg-bg-surface px-2.5 pb-2 pl-8">
                      {showWorkspaceDefault && (
                        <div className="mb-1 truncate text-[10px] text-text-faint">
                          Task default: <span className="font-mono">{task.cwd}</span>
                        </div>
                      )}
                      <TaskGitStatusSummary gitStatus={workspaceStatus} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

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
        </PullToRefresh>
      </div>
    </div>
  );
}

const ALERT_TONE_CLASS: Record<TaskAlertTone, string> = {
  accent: "bg-accent/15 text-accent",
  info: "bg-info/15 text-info",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-error/15 text-error",
};

function getStatusBadgeClass(status: Task["status"]): string {
  return `rounded-full px-1.5 py-0.5 text-[10px] capitalize ${
    status === "active"
      ? "bg-success/15 text-success"
      : status === "done"
        ? "bg-accent/15 text-accent"
        : "bg-text-muted/15 text-text-muted"
  }`;
}
