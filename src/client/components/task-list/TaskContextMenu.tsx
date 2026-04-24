import { useState, useCallback, useMemo } from "react";
import { getSessionActivityTime, type Task, type TaskGroup, type Session } from "../../api";
import { GROUP_COLOR_DOT } from "../../group-colors";
import { Eye, Copy, Check, Play, CheckCircle, Archive, ArchiveRestore, Trash2, FolderOpen, FolderMinus, Pin, CalendarDays, X } from "lucide-react";
import ContextMenu, { CtxItem, CtxDivider } from "../ContextMenu";
import { countTaskUnread } from "../../hooks/useTaskIndicators";

type TaskMenuUpdates = {
  title?: Task["title"];
  status?: Task["status"];
  pinned?: Task["pinned"];
  nextTouchAt?: Task["nextTouchAt"] | null;
};

interface TaskContextMenuActions {
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (taskId: string, updates: TaskMenuUpdates) => void;
  onDeleteTask?: (taskId: string) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
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
  const { markRead, onUpdateTask, onDeleteTask, onMoveTaskToGroup, onCreateGroup } = actions;

  const [copied, setCopied] = useState(false);
  const closeMenu = useCallback(() => { setCopied(false); onClose(); }, [onClose]);

  const unreadCount = useMemo(() => {
    if (!isUnread) return 0;
    return countTaskUnread(task, sessionMap, isUnread, activeSessionId);
  }, [task, sessionMap, isUnread, activeSessionId]);

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
                markRead(sid);
              }
            }
            closeMenu();
          }}
        />
      )}

      {/* Copy Task ID */}
      <button
        className="w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors"
        onClick={() => {
          navigator.clipboard.writeText(task.id);
          setCopied(true);
          setTimeout(closeMenu, 600);
        }}
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {copied ? "Copied!" : "Copy Task ID"}
      </button>

      <CtxDivider />

      {/* Pin / Unpin */}
      {onUpdateTask && (
        <CtxItem
          icon={<Pin size={14} className={task.pinned ? "rotate-45" : ""} />}
          label={task.pinned ? "Unpin" : "Pin"}
          onClick={() => { onUpdateTask(task.id, { pinned: !task.pinned }); closeMenu(); }}
        />
      )}

      {/* Status changes */}
      {onUpdateTask && task.status !== "active" && (
        <CtxItem
          icon={<Play size={14} />}
          label="Set Active"
          onClick={() => { onUpdateTask(task.id, { status: "active" }); closeMenu(); }}
        />
      )}
      {onUpdateTask && task.status !== "done" && task.status !== "archived" && (
        <CtxItem
          icon={<CheckCircle size={14} />}
          label="Mark done"
          onClick={() => { onUpdateTask(task.id, { status: "done" }); closeMenu(); }}
        />
      )}
      {onUpdateTask && (
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
            label="Follow up tomorrow"
            onClick={() => { onUpdateTask(task.id, { nextTouchAt: toRelativeFollowUpAt(1) }); closeMenu(); }}
          />
          <CtxItem
            icon={<CalendarDays size={14} />}
            label="Follow up next week"
            onClick={() => { onUpdateTask(task.id, { nextTouchAt: toRelativeFollowUpAt(7) }); closeMenu(); }}
          />
          <CtxItem
            icon={<X size={14} />}
            label="Clear follow-up"
            disabled={!task.nextTouchAt}
            onClick={() => { onUpdateTask(task.id, { nextTouchAt: null }); closeMenu(); }}
          />
        </>
      )}

      {/* Move to Group */}
      {onMoveTaskToGroup && taskGroups.length > 0 && (
        <>
          <CtxDivider />
          <div className="px-3 py-1 text-[10px] font-semibold text-text-faint uppercase tracking-wider">Move to Group</div>
          {taskGroups.map((g) => (
            <CtxItem
              key={g.id}
              icon={<span className={`w-2.5 h-2.5 rounded-full ${GROUP_COLOR_DOT[g.color] ?? "bg-slate-500"}`} />}
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
