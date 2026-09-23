import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSessionActivityTime, type EnrichedTaskData, type Task, type TaskGroup, type Session, type TaskPatch } from "../../api";
import { AlertTriangle, Bell, BellOff, Eye, Copy, Check, Play, CheckCircle, Archive, ArchiveRestore, Trash2, FolderOpen, FolderMinus, CalendarDays, X, ArrowUpDown } from "lucide-react";
import { queryKeys } from "../../queryClient";
import { writeClipboardText } from "../../lib/clipboard";
import { useTaskChecklistItemsQuery } from "../../hooks/queries/useChecklistItems";
import {
  getTaskCompletionCounts,
  getTaskCompletionState,
  shouldShowTaskArchiveToggle,
} from "../../task-completion-helpers";
import ContextMenu, { CtxItem, CtxDivider } from "../ContextMenu";
import { countTaskUnread } from "../../hooks/useTaskIndicators";
import { isOngoingTask } from "../../task-kind";
import TaskDeferralDialog from "../TaskDeferralDialog";
import { IdentitySwatch } from "../../design/primitives";

type TaskMenuUpdates = {
  title?: TaskPatch["title"];
  muted?: TaskPatch["muted"];
  status?: TaskPatch["status"];
  nextTouchAt?: TaskPatch["nextTouchAt"];
  completionAction?: TaskPatch["completionAction"];
};

interface TaskContextMenuActions {
  markRead?: (sessionId: string, readThroughActivityAt?: string) => void;
  onUpdateTask?: (taskId: string, updates: TaskMenuUpdates) => void;
  onDeleteTask?: (taskId: string) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  /** Enter the list's reorder mode. Passed only when the list can be reordered. */
  onStartReorder?: () => void;
}

interface TaskContextMenuProps {
  task: Task;
  position: { x: number; y: number };
  taskGroups: TaskGroup[];
  sessionMap: Map<string, Session>;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  activeSessionId?: string | null;
  actions: TaskContextMenuActions;
  onClose: () => void;
}

export default function TaskContextMenu({
  task,
  position,
  taskGroups,
  sessionMap,
  isUnread,
  activeSessionId,
  actions,
  onClose,
}: TaskContextMenuProps) {
  const { markRead, onUpdateTask, onDeleteTask, onMoveTaskToGroup, onCreateGroup, onStartReorder } = actions;
  const queryClient = useQueryClient();
  const checklistItemsQuery = useTaskChecklistItemsQuery(task.id);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [deferralOpen, setDeferralOpen] = useState(false);
  const copyRequestRef = useRef(0);
  useEffect(() => () => { copyRequestRef.current += 1; }, []);
  const closeMenu = useCallback(() => {
    copyRequestRef.current += 1;
    setCopyState("idle");
    onClose();
  }, [onClose]);

  const unreadCount = useMemo(() => {
    if (!isUnread) return 0;
    return countTaskUnread(task, sessionMap, isUnread, activeSessionId);
  }, [task, sessionMap, isUnread, activeSessionId]);
  const completionState = useMemo(() => {
    const checklistItems = checklistItemsQuery.data ?? [];
    const enriched = queryClient.getQueryData<EnrichedTaskData>(queryKeys.taskEnriched(task.id));
    const linkedSessions = task.sessionIds
      .map((sessionId) => sessionMap.get(sessionId))
      .filter((session): session is Session => Boolean(session));

    const counts = getTaskCompletionCounts({
      checklistItems,
      linkedSessions,
      pullRequests: enriched?.pullRequests?.length
        ? enriched.pullRequests
        : task.pullRequests.map(() => ({ status: null })),
    });

    return getTaskCompletionState(task, counts, {
      checklistLoaded: checklistItemsQuery.data !== undefined,
    });
  }, [checklistItemsQuery.data, queryClient, sessionMap, task]);
  const showArchiveToggle = shouldShowTaskArchiveToggle(task, completionState);

  if (deferralOpen) return <TaskDeferralDialog task={task} onClose={closeMenu} />;

  return (
    <ContextMenu position={position} onClose={closeMenu}>
      {/* Mark all as read */}
      {markRead && (
        <CtxItem
          icon={<Eye size={14} />}
          label={`Mark all as read${unreadCount > 0 ? ` (${unreadCount})` : ""}`}
          disabled={unreadCount === 0}
          onClick={() => {
            for (const sid of task.sessionIds) {
              const session = sessionMap.get(sid);
              if (session && !session.archived && isUnread?.(sid, getSessionActivityTime(session))) {
                markRead(sid, getSessionActivityTime(session));
              }
            }
            closeMenu();
          }}
        />
      )}
      {onUpdateTask && (
        <CtxItem
          icon={task.muted ? <Bell size={14} /> : <BellOff size={14} />}
          label={task.muted ? "Unmute unread indicators" : "Mute unread indicators"}
          onClick={() => { onUpdateTask(task.id, { muted: !task.muted }); closeMenu(); }}
        />
      )}

      {/* Copy Task ID */}
      <button
        className="w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors"
        onClick={() => {
          const requestId = copyRequestRef.current + 1;
          copyRequestRef.current = requestId;
          setCopyState("idle");
          void writeClipboardText(task.id).then(() => {
            if (copyRequestRef.current !== requestId) return;
            setCopyState("copied");
            setTimeout(() => {
              if (copyRequestRef.current !== requestId) return;
              closeMenu();
            }, 600);
          }, () => {
            if (copyRequestRef.current !== requestId) return;
            setCopyState("failed");
          });
        }}
      >
        {copyState === "copied" && <Check size={14} className="text-success" />}
        {copyState === "failed" && <AlertTriangle size={14} className="text-error" />}
        {copyState === "idle" && <Copy size={14} />}
        {copyState === "failed"
          ? <span className="text-error" role="alert">Copy failed</span>
          : <span>{copyState === "copied" ? "Copied!" : "Copy Task ID"}</span>}
      </button>

      <CtxDivider />

      {/* Status changes */}
      {onUpdateTask && task.status !== "active" && completionState.ctaState !== "completed" && (
        <CtxItem
          icon={<Play size={14} />}
          label="Set Active"
          onClick={() => { onUpdateTask(task.id, { status: "active" }); closeMenu(); }}
        />
      )}
      {onUpdateTask && !isOngoingTask(task) && (task.status !== "archived" || completionState.ctaState === "completed") && (
        <CtxItem
          icon={<CheckCircle size={14} />}
          label={completionState.ctaLabel}
          disabled={!completionState.ctaNextStatus && !completionState.ctaCompletionAction}
          title={completionState.ctaDescription}
          onClick={() => {
            if (completionState.ctaCompletionAction) {
              onUpdateTask(task.id, { completionAction: completionState.ctaCompletionAction });
              closeMenu();
              return;
            }
            const nextStatus = completionState.ctaNextStatus;
            if (!nextStatus) return;
            onUpdateTask(task.id, { status: nextStatus });
            closeMenu();
          }}
        />
      )}
      {onUpdateTask && showArchiveToggle && (
        <CtxItem
          icon={task.status === "archived" ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          label={task.status === "archived" ? "Unarchive" : "Archive"}
          onClick={() => {
            onUpdateTask(task.id, { status: task.status === "archived" ? "active" : "archived" });
            closeMenu();
          }}
        />
      )}
      {onUpdateTask && task.status === "active" && (
        <>
          <CtxDivider />
          <CtxItem
            icon={<CalendarDays size={14} />}
            label={task.deferred ? "Resume task…" : "Defer task…"}
            onClick={() => setDeferralOpen(true)}
          />
          <CtxItem
            icon={<CalendarDays size={14} />}
            label="Revisit tomorrow"
            onClick={() => { onUpdateTask(task.id, { nextTouchAt: toRelativeFollowUpAt(1) }); closeMenu(); }}
          />
          <CtxItem
            icon={<CalendarDays size={14} />}
            label="Revisit next week"
            onClick={() => { onUpdateTask(task.id, { nextTouchAt: toRelativeFollowUpAt(7) }); closeMenu(); }}
          />
          <CtxItem
            icon={<X size={14} />}
            label="Clear revisit date"
            disabled={!task.nextTouchAt}
            onClick={() => { onUpdateTask(task.id, { nextTouchAt: null }); closeMenu(); }}
          />
        </>
      )}

      {onStartReorder && task.status === "active" && (
        <>
          <CtxDivider />
          <CtxItem
            icon={<ArrowUpDown size={14} />}
            label="Reorder tasks"
            onClick={() => { closeMenu(); onStartReorder(); }}
          />
        </>
      )}

      {/* Move to Group */}
      {onMoveTaskToGroup && taskGroups.length > 0 && (
        <>
          <CtxDivider />
          <div className="px-3 py-1 text-xs font-medium text-text-muted">Move to group</div>
          {taskGroups.map((g) => (
            <CtxItem
              key={g.id}
              icon={<IdentitySwatch color={g.color} size="md" />}
              label={g.name}
              className={task.groupId === g.id ? "text-accent font-medium" : ""}
              onClick={() => {
                if (task.groupId !== g.id) onMoveTaskToGroup(task.id, g.id);
                closeMenu();
              }}
            />
          ))}
          {task.groupId && (
            <CtxItem
              icon={<FolderMinus size={14} />}
              label="Remove from group"
              onClick={() => { onMoveTaskToGroup(task.id, undefined); closeMenu(); }}
            />
          )}
        </>
      )}
      {onMoveTaskToGroup && onCreateGroup && (
        <>
          {taskGroups.length === 0 && <CtxDivider />}
          <CtxItem
            icon={<FolderOpen size={14} />}
            label="New Group..."
            onClick={async () => {
              closeMenu();
              const name = window.prompt("Group name:");
              if (name?.trim()) {
                const group = await onCreateGroup(name.trim());
                if (group) onMoveTaskToGroup(task.id, group.id);
              }
            }}
          />
        </>
      )}

      {/* Delete */}
      {onDeleteTask && (
        <>
          <CtxDivider />
          <CtxItem
            icon={<Trash2 size={14} />}
            label="Delete"
            className="text-error"
            onClick={() => { onDeleteTask(task.id); closeMenu(); }}
          />
        </>
      )}
    </ContextMenu>
  );
}

function toRelativeFollowUpAt(daysFromToday: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString();
}
