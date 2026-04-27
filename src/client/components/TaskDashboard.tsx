import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Task, TaskGroup, Session } from "../api";
import { patchTask, getSessionActivityTime } from "../api";
import { GROUP_COLOR_DOT } from "../group-colors";
import { timeAgo } from "../time";
import { useTaskWorkspace } from "../hooks/useTaskWorkspace";
import { hasTaskDashboardFocusParams } from "../lib/mobile-scroll-restoration";
import { resolveTaskDashboardFocus, type TaskFocusRequest } from "../task-detail-focus";
import { getTaskCompletionCounts, getTaskCompletionState } from "../task-completion-helpers";
import EmptyState from "./shared/EmptyState";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import TaskSessionList from "./TaskSessionList";
import NotesSheet from "./NotesSheet";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import TaskGitStatusSummary from "./TaskGitStatusSummary";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";
import { TagPillList } from "./TagPill";
import TagPicker from "./TagPicker";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import TaskMomentumFields, { getFollowUpState } from "./TaskMomentumFields";
import TaskKindSwitcher from "./TaskKindSwitcher";
import {
  MessageSquare,
  Plus,
  GitPullRequest,
  ClipboardList,
  Clock,
  FolderOpen,
  Pencil,
  StickyNote,
  CheckSquare,
  LayoutDashboard,
  BookOpen,
  FileText,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import {
  WorkItemList,
  PullRequestList,
  TaskChecklistSection,
  TaskNotesSection,
  RelatedDocsSection,
  ScheduleSection,
} from "./task-sections";
import { getTaskKindUpdate, isOngoingTask } from "../task-kind";

// ── Props ────────────────────────────────────────────────────────

interface TaskDashboardProps {
  task: Task;
  taskGroups?: TaskGroup[];
  sessions: Session[];
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: Parameters<typeof patchTask>[1]) => Promise<Task | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>) => void;
  onTasksChanged?: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  onSetTaskTags?: (taskId: string, tagIds: string[]) => void;
  onRefresh?: () => Promise<void>;
  // Session actions (for context menu)
  onDeleteSession?: (sessionId: string) => void;
  onDuplicateSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  exitingIds?: Set<string>;
  onBulkAction?: (action: import("../api").BatchAction, sessionIds: string[]) => void;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  hasDraft?: (sessionId: string) => boolean;
  // Lazy-load archived sessions
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
  scrollRestoration?: PullToRefreshScrollRestoration;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskDashboard({
  task,
  taskGroups = [],
  sessions,
  onSelectSession,
  onNewSession,
  onUpdateTask,
  onUpdateGroup,
  onTasksChanged,
  isUnread,
  onSetTaskTags,
  onRefresh,
  onDeleteSession,
  onDuplicateSession,
  onReloadSession,
  onArchiveSession,
  archivingIds,
  exitingIds,
  onBulkAction,
  onUnlinkFromTask,
  onMarkUnread,
  hasDraft,
  onRequestArchived,
  archivedLoaded,
  archivedLoading,
  scrollRestoration,
}: TaskDashboardProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const scrollRestorationSuppressionRef = useRef<{ taskId: string; suppress: boolean } | null>(null);
  let scrollRestorationSuppression = scrollRestorationSuppressionRef.current;
  if (scrollRestorationSuppression?.taskId !== task.id) {
    scrollRestorationSuppression = {
      taskId: task.id,
      suppress: hasTaskDashboardFocusParams(searchParams),
    };
    scrollRestorationSuppressionRef.current = scrollRestorationSuppression;
  }
  const scrollRestorationForVisit = scrollRestoration
    ? {
        ...scrollRestoration,
        restore: scrollRestoration.restore !== false && !scrollRestorationSuppression.suppress,
      }
    : undefined;

  // ── Consolidated workspace hook ─────────────────────────────
  const ws = useTaskWorkspace(task, taskGroups, sessions);
  const {
    enrichedWIs, enrichedPRs,
    sched, schedDetail,
    notes,
    taskGitStatus,
    checklistItems, checklistItemsReady, checklistLoaded, createChecklistItemMutation, onChecklistItemUpdate, onChecklistItemDelete,
    newChecklistItemText, setNewChecklistItemText,
    linkedSessions,
    taskOwnTags, taskGroup: group, inheritedTagIds, effectiveTags,
    relatedDocs,
    refresh,
  } = ws;
  const [groupNotesOpen, setGroupNotesOpen] = useState(false);
  const [groupNotesStartEdit, setGroupNotesStartEdit] = useState(false);
  const [momentumTask, setMomentumTask] = useState(task);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const [highlightedSection, setHighlightedSection] = useState<"sessions" | "checklist" | null>(null);
  const [highlightedChecklistItemId, setHighlightedChecklistItemId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<TaskFocusRequest | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const sessionsSectionRef = useRef<HTMLDivElement>(null);
  const checklistSectionRef = useRef<HTMLDivElement>(null);
  const latestTaskIdRef = useRef(task.id);
  const [isUpdatingCompletion, setIsUpdatingCompletion] = useState(false);
  const focusedSection = searchParams.get("section");
  const focusedChecklistItemId = searchParams.get("checklistItem");

  useEffect(() => {
    latestTaskIdRef.current = task.id;
    setMomentumTask(task);
    setIsUpdatingCompletion(false);
  }, [task]);

  useEffect(() => {
    setWorkspaceSheetOpen(false);
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedSection(null);
    setHighlightedChecklistItemId(null);
    setFocusRequest(null);
  }, [task.id]);

  useEffect(() => {
    const resolvedFocus = resolveTaskDashboardFocus({
      focusedSection,
      focusedChecklistItemId,
      checklistItems,
      checklistItemsReady,
    });

    if (!resolvedFocus.request || !resolvedFocus.consumeParams) return;

    setFocusRequest(resolvedFocus.request);

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("section");
      next.delete("checklistItem");
      return next;
    }, { replace: true });
  }, [checklistItems, checklistItemsReady, focusedChecklistItemId, focusedSection, setSearchParams]);

  useEffect(() => {
    if (!focusRequest) return;

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }

    setHighlightedSection(null);
    setHighlightedChecklistItemId(null);

    const frameId = requestAnimationFrame(() => {
      const target = focusRequest.section === "sessions"
        ? sessionsSectionRef.current
        : checklistSectionRef.current;

      setHighlightedSection(focusRequest.section);
      setHighlightedChecklistItemId(focusRequest.checklistItemId ?? null);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });

      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedSection((current) => (
          current === focusRequest.section ? null : current
        ));
        setHighlightedChecklistItemId((current) => (
          current === (focusRequest.checklistItemId ?? null) ? null : current
        ));
        highlightTimerRef.current = null;
      }, 1600);
    });

    return () => cancelAnimationFrame(frameId);
  }, [focusRequest]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const handleRefresh = async () => {
    await Promise.all([refresh(), onRefresh?.()]);
  };

  const handleKindChange = (nextKind: Task["kind"]) => {
    const updates = getTaskKindUpdate(momentumTask, nextKind);
    if (!updates) return;
    void onUpdateTask(task.id, updates);
  };

  const lastActivity = useMemo(() => {
    let latest = momentumTask.updatedAt;
    for (const s of linkedSessions) {
      const t = getSessionActivityTime(s);
      if (t && t > latest) latest = t;
    }
    return latest;
  }, [momentumTask.updatedAt, linkedSessions]);

  const completedChecklistItems = checklistItems.filter((t) => t.done);
  const completionCounts = useMemo(() => getTaskCompletionCounts({
    checklistItems,
    linkedSessions,
    pullRequests: enrichedPRs.length > 0
      ? enrichedPRs
      : task.pullRequests.map(() => ({ status: null })),
  }), [checklistItems, linkedSessions, enrichedPRs, task.pullRequests]);
  const completionState = useMemo(
    () => getTaskCompletionState(momentumTask, completionCounts, { checklistLoaded }),
    [momentumTask, completionCounts, checklistLoaded],
  );
  const momentumChips = useMemo(() => {
    const chips: Array<{ label: string; className: string; title?: string }> = [];
    const followUpState = getFollowUpState(momentumTask.nextTouchAt);

    if (
      momentumTask.status === "active"
      && !momentumTask.nextAction
      && !momentumTask.waitingOn
      && !momentumTask.nextTouchAt
    ) {
      chips.push({
        label: "Needs decision",
        className: "bg-accent/15 text-accent",
        title: "No next action, waiting reason, or follow-up is set",
      });
    }
    if (followUpState === "overdue") {
      chips.push({
        label: "Follow up overdue",
        className: "bg-error/15 text-error",
        title: "This task is due for follow-up",
      });
    } else if (followUpState === "due") {
      chips.push({
        label: "Follow up now",
        className: "bg-warning/15 text-warning",
        title: "This task should be revisited now",
      });
    }
    if (momentumTask.status === "active" && momentumTask.waitingOn) {
      chips.push({
        label: "Waiting",
        className: "bg-info/15 text-info",
        title: momentumTask.waitingOn,
      });
    }
    if (!isOngoingTask(momentumTask) && completionState.isStrongCloseCandidate) {
      chips.push({
        label: "Candidate to close",
        className: "bg-success/15 text-success",
        title: completionState.ctaDescription,
      });
    }

    return chips;
  }, [completionState, momentumTask]);

  const completionDisabled = isOngoingTask(momentumTask)
    || (!completionState.ctaNextStatus && !completionState.ctaCompletionAction)
    || isUpdatingCompletion;
  const completionDescription = isOngoingTask(momentumTask)
    ? "Ongoing tasks stay active and cannot be completed."
    : completionState.ctaDescription;
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
    <div className="flex-1 min-h-0 relative">
    <PullToRefresh
      onRefresh={handleRefresh}
      className="absolute inset-0"
      scrollRestoration={scrollRestorationForVisit}
    >
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-6 space-y-6">
        {/* ── Task Header ─────────────────────────────────── */}
        <div>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <LayoutDashboard size={16} className="text-text-muted shrink-0" />
                {group && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-muted bg-bg-hover shrink-0">
                    <span className={`w-2 h-2 rounded-full ${GROUP_COLOR_DOT[group.color] ?? "bg-slate-500"}`} />
                    <span>{group.name}</span>
                  </div>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${
                  momentumTask.status === "active" ? "bg-success/15 text-success" :
                  momentumTask.status === "done" ? "bg-accent/15 text-accent" :
                  "bg-text-muted/15 text-text-muted"
                }`}>
                  {momentumTask.status}
                </span>
                <TaskKindSwitcher kind={momentumTask.kind} onChange={handleKindChange} />
              </div>
              <h1 className="text-xl font-semibold text-text-primary leading-tight">
                {task.title}
              </h1>
              {/* Tags */}
              {(effectiveTags.length > 0 || onSetTaskTags) && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <TagPillList
                    tags={effectiveTags}
                    inheritedTagIds={inheritedTagIds}
                    size="sm"
                    onRemove={onSetTaskTags ? (tagId) => {
                      const newIds = taskOwnTags.filter((t) => t.id !== tagId).map((t) => t.id);
                      onSetTaskTags(task.id, newIds);
                    } : undefined}
                  />
                  {onSetTaskTags && (
                    <TagPicker
                      selectedTagIds={taskOwnTags.map((t) => t.id)}
                      inheritedTagIds={inheritedTagIds}
                      onChange={(tagIds) => onSetTaskTags(task.id, tagIds)}
                    />
                  )}
                </div>
              )}
              <button
                onClick={() => setWorkspaceSheetOpen(true)}
                className="-ml-1 mt-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-bg-hover/70"
              >
                <div className="flex items-center gap-1.5 text-xs text-text-muted">
                  <FolderOpen size={12} className="text-text-faint" />
                  <span className="font-mono">{task.cwd ?? "Set workspace…"}</span>
                </div>
                <TaskGitStatusSummary
                  gitStatus={taskGitStatus}
                  className="mt-1 pl-[18px] text-[11px]"
                />
              </button>
              <div className="text-xs text-text-faint mt-1">
                Last activity {timeAgo(lastActivity)} · Created {timeAgo(momentumTask.createdAt)}
              </div>
              {momentumChips.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {momentumChips.map((chip) => (
                    <span
                      key={chip.label}
                      className={`text-[10px] px-2 py-0.5 rounded-full ${chip.className}`}
                      title={chip.title}
                    >
                      {chip.label}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <TaskMomentumFields
                  task={momentumTask}
                  variant="dashboard"
                  onPatched={setMomentumTask}
                  onSaved={() => {
                    void onTasksChanged?.();
                  }}
                />
              </div>
            </div>
            <div className="flex flex-col items-stretch gap-2 shrink-0 min-w-[11rem]">
              <button
                onClick={() => { void handleCompletionAction(); }}
                disabled={completionDisabled}
                title={completionDescription}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center justify-center gap-1.5 disabled:bg-bg-hover disabled:text-text-faint disabled:hover:bg-bg-hover"
              >
                {completionState.ctaState === "completed" ? <RotateCcw size={12} /> : <CheckCircle2 size={12} />}
                {completionState.ctaLabel}
              </button>
              <button
                onClick={() => onNewSession(task.id)}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-bg-hover text-text-primary hover:bg-border transition-colors flex items-center justify-center gap-1.5"
              >
                <Plus size={12} />
                New Chat
              </button>
              <p className="text-[11px] text-text-muted text-right leading-relaxed">
                {completionDescription}
              </p>
            </div>
          </div>
        </div>

        {/* ── Two-column grid ─────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Left Column ─────────────────────────────── */}
          <div className="space-y-6">
            {/* Sessions */}
            <div
              ref={sessionsSectionRef}
              className={highlightedSection === "sessions" ? "animate-checklist-highlight rounded-lg" : ""}
            >
              <Section
                icon={<MessageSquare size={14} />}
                title="Sessions"
                count={task.sessionIds.length}
                action={
                  <button
                    onClick={() => onNewSession(task.id)}
                    className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                  >
                    <Plus size={12} /> New
                  </button>
                }
              >
                {task.sessionIds.length === 0 ? (
                  <EmptyState message="No sessions yet" sub="Start a chat to begin working" />
                ) : (
                  <TaskSessionList
                    task={task}
                    linkedSessions={linkedSessions}
                    activeSessionId={null}
                    onSelectSession={onSelectSession}
                    onNewSession={onNewSession}
                    showEmptyState={false}
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
                    className=""
                  />
                )}
              </Section>
            </div>

            {/* Work Items */}
            {task.workItems.length > 0 && (
              <Section
                icon={<ClipboardList size={14} />}
                title="Work Items"
                count={task.workItems.length}
              >
                <WorkItemList
                  enrichedWIs={enrichedWIs}
                  rawWIs={task.workItems}
                  variant="card"
                />
              </Section>
            )}

            {/* Pull Requests */}
            {task.pullRequests.length > 0 && (
              <Section
                icon={<GitPullRequest size={14} />}
                title="Pull Requests"
                count={task.pullRequests.length}
              >
                <PullRequestList
                  enrichedPRs={enrichedPRs}
                  rawPRs={task.pullRequests}
                  variant="card"
                />
              </Section>
            )}
          </div>

          {/* ── Right Column ─────────────────────────────── */}
          <div className="space-y-6">
            {/* Checklist */}
            <div
              ref={checklistSectionRef}
              className={highlightedSection === "checklist" ? "animate-checklist-highlight rounded-lg" : ""}
            >
              <Section
                icon={<CheckSquare size={14} />}
                title="Checklist"
                count={checklistItems.length > 0 ? `${completedChecklistItems.length}/${checklistItems.length}` : undefined}
              >
                <TaskChecklistSection
                  taskId={task.id}
                  checklistItems={checklistItems}
                  newChecklistItemText={newChecklistItemText}
                  onNewChecklistItemTextChange={setNewChecklistItemText}
                  onCreateChecklistItem={async (text) => { await createChecklistItemMutation.mutateAsync({ text }); }}
                  onChecklistItemUpdate={onChecklistItemUpdate}
                  onChecklistItemDelete={(id) => onChecklistItemDelete(id)}
                  variant="card"
                  highlightId={highlightedChecklistItemId}
                  isReadyToComplete={!isOngoingTask(momentumTask) && completionState.isReadyToComplete}
                />
              </Section>
            </div>

            {/* Schedules */}
            <Section
              icon={<Clock size={14} />}
              title="Schedules"
              count={sched.schedules.length}
              action={
                <button
                  onClick={() => schedDetail.openForCreate(task.id)}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  <Plus size={12} /> Add
                </button>
              }
            >
              {sched.schedules.length === 0 ? (
                <EmptyState message="No schedules" sub="Automate recurring work with scheduled sessions" />
              ) : (
                <ScheduleSection
                  schedules={sched.schedules}
                  variant="card"
                  onOpen={(s) => schedDetail.openSheet(s)}
                  onTrigger={(id) => sched.trigger(id)}
                  onToggle={(s) => sched.toggle(s)}
                  onEdit={(s) => schedDetail.openSheet(s, "edit")}
                  onDelete={(id) => sched.remove(id)}
                />
              )}
            </Section>

            {/* Group Notes */}
            {group && (
              <Section
                icon={<FileText size={14} />}
                title={`Group Notes — ${group.name}`}
                action={
                  <button
                    onClick={() => { setGroupNotesOpen(true); setGroupNotesStartEdit(!group.notes); }}
                    className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                  >
                    <Pencil size={12} /> {group.notes ? "Edit" : "Add"}
                  </button>
                }
              >
                {group.notes ? (
                  <div
                    onClick={() => { setGroupNotesOpen(true); setGroupNotesStartEdit(false); }}
                    className="px-3 py-3 cursor-pointer rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
                  >
                    <div className="prose prose-invert prose-sm max-w-none text-text-secondary
                      prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1
                      prose-ul:my-1 prose-ol:my-1 prose-li:my-0
                      prose-code:text-accent prose-code:text-xs
                      prose-a:text-accent prose-a:no-underline">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{group.notes}</ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <EmptyState message="No group notes" sub="Add notes to capture project context and goals" />
                )}
              </Section>
            )}

            {/* Notes */}
            <Section
              icon={<StickyNote size={14} />}
              title="Notes"
              action={
                <button
                  onClick={notes.openToEdit}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  <Pencil size={12} /> {task.notes ? "Edit" : "Add"}
                </button>
              }
            >
              {task.notes ? (
                <TaskNotesSection
                  notes={task.notes}
                  onView={notes.openToView}
                  onEdit={notes.openToEdit}
                />
              ) : (
                <EmptyState message="No notes" sub="Add notes to keep track of context and decisions" />
              )}
            </Section>

            {/* Related Docs */}
            {relatedDocs.length > 0 && (
              <Section
                icon={<BookOpen size={14} />}
                title="Related Docs"
                count={relatedDocs.length}
              >
                <RelatedDocsSection
                  docs={relatedDocs}
                  variant="card"
                  resetKey={task.id}
                />
              </Section>
            )}
          </div>
        </div>
      </div>

      {/* Notes Sheet */}
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

      {/* Group Notes Sheet */}
      {groupNotesOpen && group && (
        <NotesSheet
          notes={group.notes}
          startInEditMode={groupNotesStartEdit}
          onSave={(newNotes) => {
            if (onUpdateGroup) onUpdateGroup(group.id, { notes: newNotes });
          }}
          onClose={() => setGroupNotesOpen(false)}
        />
      )}

      {/* Schedule Detail Sheet (unified view/edit/create) */}
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
          onSaved={() => { schedDetail.close(); sched.reload(); }}
          onSelectSession={onSelectSession}
        />
      )}
      {workspaceSheetOpen && (
        <WorkspaceDetailsSheet
          task={task}
          taskGitStatus={taskGitStatus}
          onClose={() => setWorkspaceSheetOpen(false)}
          onTaskUpdated={onTasksChanged}
        />
      )}
    </PullToRefresh>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function Section({
  icon,
  title,
  count,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number | string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
          {icon}
          {title}
          {count !== undefined && (
            <span className="text-text-faint font-normal">({count})</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}


