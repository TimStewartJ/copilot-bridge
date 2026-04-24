import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { Task, TaskGroup, Session } from "../api";
import { GROUP_COLOR_DOT } from "../group-colors";
import { unlinkResource, patchTask } from "../api";
import { useTagsQuery } from "../hooks/queries/useTags";
import { useTaskWorkspace } from "../hooks/useTaskWorkspace";
import SessionList from "./SessionList";
import PullToRefresh from "./PullToRefresh";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import NotesSheet from "./NotesSheet";
import { TagPillList } from "./TagPill";
import TagPicker from "./TagPicker";
import {
  FolderOpen,
  Copy,
  Check,
  Pencil,
  LayoutDashboard,
  BookOpen,
  Pin,
} from "lucide-react";
import DocPreviewSheet from "./DocPreviewSheet";
import TaskMomentumFields from "./TaskMomentumFields";
import {
  WorkItemList,
  PullRequestList,
  TaskChecklistSection,
  TaskNotesSection,
  RelatedDocsSection,
  ScheduleSection,
} from "./task-sections";

// ── Compact section header for sidebar ───────────────────────────



function SectionLabel({ label, count, progress }: { label: string; count?: number; progress?: string }) {
  return (
    <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider px-3 py-1">
      {label}
      {progress !== undefined && (
        <span className="text-text-faint ml-1">({progress})</span>
      )}
      {progress === undefined && count !== undefined && (
        <span className="text-text-faint ml-1">({count})</span>
      )}
    </div>
  );
}

// ── Props ────────────────────────────────────────────────────────

interface TaskPanelProps {
  // Task mode
  task: Task | null;
  taskGroups?: TaskGroup[];
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: Partial<Pick<Task, "title" | "status" | "pinned">>,
  ) => void;
  onTasksChanged?: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  onArchiveSession?: (id: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  exitingIds?: Set<string>;
  // Linking
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
  onViewDashboard?: (taskId: string) => void;
  // Bulk actions
  onMarkAllRead?: () => void;
  onBulkAction?: (action: import("../api").BatchAction, sessionIds: string[]) => void;
  // Lazy-load archived sessions
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  // Tags
  onSetTaskTags?: (taskId: string, tagIds: string[]) => void;
}

// ── Component ────────────────────────────────────────────────────

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
  onSetTaskTags,
}: TaskPanelProps) {
  const { data: allTags = [] } = useTagsQuery();

  // ── Consolidated workspace hook ─────────────────────────────
  const ws = useTaskWorkspace(task ?? undefined, taskGroups, sessions);

  // ── Inline editing state ─────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // ── CWD editing state ──────────────────────────────────────
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwdCopied, setCwdCopied] = useState(false);

  // ── Doc preview (panel-specific) ──────────────────────────
  const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);

  // ── Checklist highlight (from dashboard navigation) ─────────
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightChecklistItemId, setHighlightChecklistItemId] = useState<string | null>(null);

  useEffect(() => {
    const checklistItemId = searchParams.get("checklistItem");
    if (checklistItemId) {
      setHighlightChecklistItemId(checklistItemId);
      setSearchParams((prev) => { prev.delete("checklistItem"); return prev; }, { replace: true });
      const timer = setTimeout(() => setHighlightChecklistItemId(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

  // Reset editing state when task changes
  useEffect(() => {
    setEditingTitle(false);
    setEditingCwd(false);
    setPreviewDocPath(null);
  }, [task?.id]);

  // ── No task selected (empty state) ───────────────────────────
  if (!task) {
    return (
      <div className="h-full w-full md:w-64 flex flex-col bg-bg-secondary border-r border-border items-center justify-center">
        <span className="text-xs text-text-faint">Select a task</span>
      </div>
    );
  }

  // ── Task mode ────────────────────────────────────────────────

  const {
    enrichedWIs, enrichedPRs, reloadEnriched,
    sched, schedDetail,
    notes,
    checklistItems, createChecklistItemMutation, onChecklistItemUpdate, onChecklistItemDelete,
    newChecklistItemText, setNewChecklistItemText,
    linkedSessions,
    taskOwnTags, inheritedTagIds, effectiveTags,
    relatedDocs,
    refresh,
  } = ws;

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdateTask(task.id, { title: trimmed });
    }
    setEditingTitle(false);
  };

  return (
    <div className="h-full w-full md:w-64 flex flex-col bg-bg-secondary border-r border-border min-w-0 overflow-hidden">
      {/* Header — inline task editing */}
      <div className="p-3 border-b border-border">
        {/* Dashboard link */}
        {onViewDashboard && (
          <button
            onClick={() => onViewDashboard(task.id)}
            className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-accent transition-colors mb-1.5"
          >
            <LayoutDashboard size={10} />
            <span>Task Overview</span>
          </button>
        )}
        <div className="flex items-start gap-2">
          {/* Title (click-to-edit) */}
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                autoFocus
                className="w-full text-sm font-medium bg-bg-surface border border-border rounded px-1.5 py-0.5 text-text-primary outline-none focus:border-accent"
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
                className="text-sm font-medium text-text-primary hover:text-accent leading-tight line-clamp-2 text-left transition-colors w-full"
                title="Click to edit title"
              >
                {task.title}
              </button>
            )}
          </div>

          {/* Pin toggle */}
          <button
            onClick={() => onUpdateTask(task.id, { pinned: !task.pinned })}
            className={`p-1 rounded transition-colors shrink-0 ${
              task.pinned
                ? "text-accent hover:text-accent-hover"
                : "text-text-faint hover:text-text-muted"
            }`}
            title={task.pinned ? "Unpin task" : "Pin task"}
          >
            <Pin size={12} className={task.pinned ? "rotate-45" : ""} />
          </button>

          {/* Group badge */}
          {(() => {
            const group = taskGroups.find((g) => g.id === task.groupId);
            if (!group) return null;
            const colorDot = GROUP_COLOR_DOT[group.color] ?? "bg-slate-500";
            return (
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-muted bg-bg-hover shrink-0" title={`Group: ${group.name}`}>
                <span className={`w-2 h-2 rounded-full ${colorDot}`} />
                <span className="truncate max-w-[80px]">{group.name}</span>
              </div>
            );
          })()}
        </div>
        {/* Tags */}
        {(effectiveTags.length > 0 || onSetTaskTags) && (
          <div className="flex items-center gap-1 flex-wrap px-3 pb-2">
            <TagPillList
              tags={effectiveTags}
              inheritedTagIds={inheritedTagIds}
              onRemove={onSetTaskTags ? (tagId) => {
                const newIds = taskOwnTags.filter((t) => t.id !== tagId).map((t) => t.id);
                onSetTaskTags(task.id, newIds);
              } : undefined}
              max={4}
            />
            {onSetTaskTags && (
              <TagPicker
                selectedTagIds={taskOwnTags.map((t) => t.id)}
                inheritedTagIds={inheritedTagIds}
                onChange={(tagIds) => onSetTaskTags(task.id, tagIds)}
                compact
              />
            )}
          </div>
        )}
        <div className="px-3 pb-3">
          <TaskMomentumFields
            task={task}
            onSaved={() => {
              void onTasksChanged?.();
            }}
          />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 relative">
      <PullToRefresh onRefresh={async () => { await Promise.all([refresh(), onRefresh?.()]); }} className="absolute inset-0 overflow-x-hidden p-2 space-y-3">
        {/* Sessions */}
        <div>
          <SectionLabel label="Sessions" count={linkedSessions.length} />
          <SessionList
            key={task.id}
            variant="compact"
            sessions={linkedSessions}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onNewSession={() => onNewSession(task.id)}
            newButtonLabel="+ New Chat"
            isUnread={isUnread}
            onArchiveSession={onArchiveSession}
            archivingIds={archivingIds}
            exitingIds={exitingIds}
            taskContext={task}
            onUnlinkFromTask={
              onUnlinkFromTask
                ? onUnlinkFromTask
                : async (sessionId, taskId) => {
                    await unlinkResource(taskId, {
                      type: "session",
                      sessionId,
                    });
                    onTasksChanged?.();
                  }
            }
            onDeleteSession={onDeleteSession}
            onDuplicateSession={onDuplicateSession}
            onReloadSession={onReloadSession}
            onMarkUnread={onMarkUnread}
            onBulkAction={onBulkAction}
            hasDraft={hasDraft}
            onRequestArchived={onRequestArchived}
            archivedLoaded={archivedLoaded}
          />
        </div>

        {/* Checklist */}
        <div>
          <SectionLabel
            label="Checklist"
            count={checklistItems.length > 0 ? undefined : 0}
            progress={checklistItems.length > 0 ? `${checklistItems.filter((t) => t.done).length}/${checklistItems.length}` : undefined}
          />
          <TaskChecklistSection
            checklistItems={checklistItems}
            newChecklistItemText={newChecklistItemText}
            onNewChecklistItemTextChange={setNewChecklistItemText}
            onCreateChecklistItem={async (text) => { await createChecklistItemMutation.mutateAsync({ text }); }}
            onChecklistItemUpdate={onChecklistItemUpdate}
            onChecklistItemDelete={(id) => onChecklistItemDelete(id)}
            variant="panel"
            highlightId={highlightChecklistItemId}
          />
        </div>

        {/* Work Items */}
        {task.workItems.length > 0 && (
          <div>
            <SectionLabel label="Work Items" count={task.workItems.length} />
            <WorkItemList
              enrichedWIs={enrichedWIs}
              rawWIs={task.workItems}
              variant="compact"
            />
          </div>
        )}

        {/* Pull Requests */}
        {task.pullRequests.length > 0 && (
          <div>
            <SectionLabel
              label="Pull Requests"
              count={task.pullRequests.length}
            />
            <PullRequestList
              enrichedPRs={enrichedPRs}
              rawPRs={task.pullRequests}
              variant="compact"
            />
          </div>
        )}

        {/* Schedules */}
        <ScheduleSection
          schedules={sched.schedules}
          variant="compact"
          label={<SectionLabel label="Schedules" count={sched.schedules.length} />}
          onAdd={() => schedDetail.openForCreate(task.id)}
          onOpen={(s) => schedDetail.openSheet(s)}
          onTrigger={(id) => sched.trigger(id)}
          onToggle={(s) => sched.toggle(s)}
          onEdit={(s) => schedDetail.openSheet(s, "edit")}
          onDelete={(id) => sched.remove(id)}
        />

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

        {/* Working Directory */}
        <div>
          <SectionLabel label="Working Directory" />
          <div className="px-3 py-1 group">
            {editingCwd ? (
              <input
                autoFocus
                className="w-full text-xs font-mono bg-bg-surface border border-border rounded px-2 py-1 text-text-primary outline-none focus:border-accent"
                value={cwdDraft}
                onChange={(e) => setCwdDraft(e.target.value)}
                onBlur={() => {
                  const trimmed = cwdDraft.trim();
                  if (trimmed !== (task.cwd ?? "")) {
                    patchTask(task.id, { cwd: trimmed || undefined as any }).then(() => onTasksChanged?.());
                  }
                  setEditingCwd(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingCwd(false);
                }}
                placeholder="e.g. D:\my-project"
              />
            ) : task.cwd ? (
              <div className="flex items-center gap-1.5">
                <FolderOpen size={12} className="text-text-faint shrink-0" />
                <span
                  className="text-xs font-mono text-text-muted truncate flex-1 cursor-pointer hover:text-text-primary transition-colors"
                  title={task.cwd}
                  onClick={() => { setCwdDraft(task.cwd ?? ""); setEditingCwd(true); }}
                >
                  {task.cwd}
                </span>
                <div className="hidden group-hover:flex items-center gap-0.5">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(task.cwd!);
                      setCwdCopied(true);
                      setTimeout(() => setCwdCopied(false), 1500);
                    }}
                    className="p-0.5 text-text-faint hover:text-text-primary transition-colors"
                    title="Copy path"
                  >
                    {cwdCopied ? <Check size={10} /> : <Copy size={10} />}
                  </button>
                  <button
                    onClick={() => { setCwdDraft(task.cwd ?? ""); setEditingCwd(true); }}
                    className="p-0.5 text-text-faint hover:text-text-primary transition-colors"
                    title="Edit"
                  >
                    <Pencil size={10} />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setCwdDraft(""); setEditingCwd(true); }}
                className="text-[10px] text-text-faint hover:text-accent transition-colors"
              >
                Set working directory…
              </button>
            )}
          </div>
        </div>

        {/* Notes */}
        <div>
          <SectionLabel label="Notes" />
          <TaskNotesSection
            notes={task.notes || undefined}
            onView={notes.openToView}
            onEdit={notes.openToEdit}
            truncate
          />
        </div>

        {/* Related Docs */}
        {relatedDocs.length > 0 && (
          <div>
            <SectionLabel label="Docs" count={relatedDocs.length} />
            <RelatedDocsSection
              docs={relatedDocs}
              variant="compact"
              onPreview={(path) => setPreviewDocPath(path)}
              resetKey={task.id}
            />
          </div>
        )}

        {/* Doc Preview Sheet */}
        {previewDocPath && (
          <DocPreviewSheet
            docPath={previewDocPath}
            onClose={() => setPreviewDocPath(null)}
          />
        )}

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
      </PullToRefresh>
      </div>
    </div>
  );
}
