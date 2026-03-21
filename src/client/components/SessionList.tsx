import { useState, useCallback, useRef } from "react";
import type { Session, Task } from "../api";
import { ChevronDown, ChevronRight, Archive, ArchiveRestore, ClipboardList, Copy, Check, Link, Unlink, Loader2, Trash2 } from "lucide-react";
import TaskPickerDialog from "./TaskPickerDialog";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const styles = {
  global: {
    wrapper: "flex-1 overflow-y-auto p-2 space-y-1",
    newButton:
      "w-full px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors",
    itemPadding: "py-2.5",
    titleClass: "font-medium truncate",
    metaClass: "text-xs text-text-muted mt-0.5",
    dotSize: "w-1.5 h-1.5 mr-1.5",
    listGap: "space-y-1",
  },
  compact: {
    wrapper: "",
    newButton:
      "w-full mb-1.5 px-3 py-1.5 bg-accent/10 text-accent border border-accent/20 rounded-md text-xs hover:bg-accent/20 transition-colors",
    itemPadding: "py-2",
    titleClass: "font-medium truncate text-xs",
    metaClass: "text-[10px] text-text-muted mt-0.5",
    dotSize: "w-1.5 h-1.5 mr-1",
    listGap: "space-y-0.5",
  },
} as const;

interface SessionListProps {
  variant: "global" | "compact";
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  newButtonLabel?: string;
  showEmptyState?: boolean;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  onArchiveSession?: (id: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  // Task linking (global variant)
  tasks?: Task[];
  onLinkToTask?: (sessionId: string, taskId: string) => void;
  // Task unlinking (compact/task-context variant)
  taskContext?: Task;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  // Session deletion
  onDeleteSession?: (sessionId: string) => void;
}

export default function SessionList({
  variant,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  newButtonLabel = variant === "global" ? "+ New Session" : "+ New Chat",
  showEmptyState = variant === "compact",
  isUnread,
  onArchiveSession,
  archivingIds,
  tasks,
  onLinkToTask,
  taskContext,
  onUnlinkFromTask,
  onDeleteSession,
}: SessionListProps) {
  const s = styles[variant];
  const [showArchived, setShowArchived] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState<string | null>(null);

  // Long-press state for mobile
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const [longPressTarget, setLongPressTarget] = useState<string | null>(null);

  const closeMenu = useCallback(() => { setCtxMenu(null); setCopied(false); }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    setLongPressTarget(null);
  }, []);

  const ctxSession = ctxMenu ? sessions.find((ss) => ss.sessionId === ctxMenu.sessionId) : null;

  // Find which task (if any) the context-menu'd session is linked to
  const ctxLinkedTask = ctxMenu && tasks
    ? tasks.find((t) => t.sessionIds.includes(ctxMenu.sessionId))
    : null;

  const activeSessions = sessions.filter((sess) => !sess.archived && !archivingIds?.has(sess.sessionId));
  const archivedSessions = sessions.filter((sess) => sess.archived);

  const renderItem = (session: Session) => {
    const id = session.sessionId;
    const isActive = id === activeSessionId;
    const unread = !isActive && isUnread?.(id, session.modifiedTime);
    const isArch = session.archived;
    const isArchiving = archivingIds?.has(id);
    const dotColor = isArchiving
      ? ""
      : session.busy
        ? "bg-info animate-pulse"
        : unread
          ? "bg-success"
          : isArch
            ? "bg-text-faint"
            : "bg-text-faint";

    return (
      <div key={id} className="group relative">
        <button
          onClick={() => {
            if (longPressTriggered.current) {
              longPressTriggered.current = false;
              return;
            }
            onSelectSession(id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, sessionId: id });
            setCopied(false);
          }}
          onTouchStart={(e) => {
            const touch = e.touches[0];
            touchOrigin.current = { x: touch.clientX, y: touch.clientY };
            longPressTriggered.current = false;
            setLongPressTarget(id);
            longPressTimer.current = setTimeout(() => {
              longPressTriggered.current = true;
              setLongPressTarget(null);
              setCtxMenu({ x: touch.clientX, y: touch.clientY, sessionId: id });
              setCopied(false);
            }, 500);
          }}
          onTouchMove={(e) => {
            if (!touchOrigin.current) return;
            const touch = e.touches[0];
            const dx = touch.clientX - touchOrigin.current.x;
            const dy = touch.clientY - touchOrigin.current.y;
            if (dx * dx + dy * dy > 100) cancelLongPress();
          }}
          onTouchEnd={() => cancelLongPress()}
          onTouchCancel={() => cancelLongPress()}
          title={session.summary || id}
          className={`w-full text-left px-3 ${s.itemPadding} rounded-md text-sm transition-all duration-150 ${
            ctxMenu?.sessionId === id
              ? "bg-bg-hover ring-1 ring-border"
              : isActive
                ? "bg-accent/10 border-l-2 border-accent"
                : "hover:bg-bg-hover"
          } ${longPressTarget === id ? "scale-[0.97] bg-bg-hover" : ""} ${isArch || isArchiving ? "opacity-50" : ""}`}
        >
          <div className={`${s.titleClass} flex items-center`}>
            {isArchiving ? (
              <Loader2 size={10} className={`${s.dotSize} animate-spin text-text-muted shrink-0`} />
            ) : (
              <span
                className={`inline-block ${s.dotSize} ${dotColor} rounded-full shrink-0`}
              />
            )}
            <span className="truncate">
              {session.summary || id.slice(0, 8)}
            </span>
          </div>
          <div className={s.metaClass}>
            {isArchiving ? "Archiving…" : timeAgo(session.modifiedTime)}
            {session.context?.branch && ` · ${session.context.branch}`}
            {session.diskSizeBytes
              ? ` · ${formatSize(session.diskSizeBytes)}`
              : ""}
            {session.hasPlan && " · "}
            {session.hasPlan && <ClipboardList size={10} className="inline" />}
          </div>
        </button>
      </div>
    );
  };

  return (
    <div className={s.wrapper}>
      <button onClick={onNewSession} className={s.newButton}>
        {newButtonLabel}
      </button>
      {showEmptyState && activeSessions.length === 0 && archivedSessions.length === 0 ? (
        <div className="text-xs text-text-faint px-3 py-1">No sessions yet</div>
      ) : (
        <>
          <div className={s.listGap}>
            {activeSessions.map(renderItem)}
          </div>
          {archivedSessions.length > 0 && (
            <>
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="w-full px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors mt-2 flex items-center gap-1"
              >
                {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Archived ({archivedSessions.length})
              </button>
              {showArchived && (
                <div className={s.listGap}>
                  {archivedSessions.map(renderItem)}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu position={ctxMenu} onClose={closeMenu}>
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              navigator.clipboard.writeText(ctxMenu.sessionId);
              setCopied(true);
              setTimeout(closeMenu, 600);
            }}
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy Session ID"}
          </button>
          {onArchiveSession && ctxSession && (
            <CtxItem
              icon={ctxSession.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              label={ctxSession.archived ? "Unarchive" : "Archive"}
              onClick={() => {
                onArchiveSession(ctxMenu.sessionId, !ctxSession.archived);
                closeMenu();
              }}
            />
          )}
          {/* Global variant: Link to Task */}
          {variant === "global" && onLinkToTask && tasks && (
            <>
              {ctxLinkedTask && (
                <div className="px-3 py-1.5 text-text-faint flex items-center gap-2 text-xs">
                  <ClipboardList size={14} />
                  <span className="truncate">On: {ctxLinkedTask.title}</span>
                </div>
              )}
              <CtxItem
                icon={<Link size={14} />}
                label={ctxLinkedTask ? "Move to Task…" : "Link to Task…"}
                onClick={() => {
                  const sid = ctxMenu.sessionId;
                  closeMenu();
                  setShowTaskPicker(sid);
                }}
              />
            </>
          )}
          {/* Compact variant (task context): Unlink from Task */}
          {variant === "compact" && taskContext && onUnlinkFromTask && (
            <CtxItem
              icon={<Unlink size={14} />}
              label="Unlink from Task"
              className="text-warning"
              onClick={() => {
                onUnlinkFromTask(ctxMenu.sessionId, taskContext.id);
                closeMenu();
              }}
            />
          )}
          {/* Delete session */}
          {onDeleteSession && ctxSession && (
            <>
              <CtxDivider />
              <CtxItem
                icon={<Trash2 size={14} />}
                label="Delete"
                className="text-error"
                disabled={ctxSession.busy}
                onClick={() => {
                  onDeleteSession(ctxMenu.sessionId);
                  closeMenu();
                }}
              />
            </>
          )}
        </ContextMenu>
      )}

      {/* Task picker dialog (global variant) */}
      {showTaskPicker && tasks && onLinkToTask && (
        <TaskPickerDialog
          tasks={tasks}
          onSelect={(taskId) => {
            onLinkToTask(showTaskPicker, taskId);
            setShowTaskPicker(null);
          }}
          onClose={() => setShowTaskPicker(null)}
        />
      )}
    </div>
  );
}
