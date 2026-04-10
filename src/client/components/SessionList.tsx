import { useState, useCallback } from "react";
import { getSessionActivityTime, type Session, type Task, type BatchAction } from "../api";
import { timeAgo } from "../time";
import { ChevronDown, ChevronRight, Archive, ArchiveRestore, ClipboardList, Copy, Check, Link, Unlink, Loader2, Trash2, Clock, EyeOff, Pencil, CopyPlus, CheckSquare, Square, SquareCheckBig, RotateCw } from "lucide-react";
import TaskPickerDialog from "./TaskPickerDialog";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import useLongPressMenu from "../hooks/useLongPressMenu";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = {
  global: {
    wrapper: "flex-1 overflow-y-auto overflow-x-hidden min-w-0 p-2 space-y-1",
    newButton:
      "w-full px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors",
    itemPadding: "py-2.5",
    titleClass: "font-medium truncate",
    metaClass: "text-xs text-text-muted mt-0.5",
    dotSize: "w-1.5 h-1.5 mr-1.5",
    listGap: "space-y-1",
  },
  compact: {
    wrapper: "min-w-0 overflow-x-hidden",
    newButton:
      "w-full mb-1.5 px-3 py-1.5 bg-accent/10 text-accent border border-accent/20 rounded-md text-xs hover:bg-accent/20 transition-colors",
    itemPadding: "py-2",
    titleClass: "font-medium truncate text-xs",
    metaClass: "text-[10px] text-text-muted mt-0.5",
    dotSize: "w-1.5 h-1.5 mr-1",
    listGap: "space-y-0.5",
  },
} as const;

// ── Bulk action bar for multi-select mode ────────────────────────
function BulkActionBar({
  activeSessions,
  selectedIds,
  onToggleSelect,
  onBulkAction,
  isUnread,
}: {
  activeSessions: Session[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onBulkAction: (action: BatchAction, ids: string[]) => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
}) {
  const count = selectedIds.size;
  const allSelected = activeSessions.length > 0 && activeSessions.every((s) => selectedIds.has(s.sessionId));
  const unreadSelected = activeSessions.filter(
    (s) => selectedIds.has(s.sessionId) && isUnread?.(s.sessionId, getSessionActivityTime(s)),
  );

  const handleToggleAll = () => {
    if (allSelected) {
      for (const s of activeSessions) onToggleSelect(s.sessionId);
    } else {
      for (const s of activeSessions) {
        if (!selectedIds.has(s.sessionId)) onToggleSelect(s.sessionId);
      }
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-xs">
      <button
        onClick={handleToggleAll}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-text-secondary"
        title={allSelected ? "Deselect all" : "Select all"}
      >
        {allSelected ? <SquareCheckBig size={13} className="text-accent" /> : <Square size={13} />}
        <span>{allSelected ? "All" : "All"}</span>
      </button>
      {count > 0 && (
        <>
          <span className="text-text-faint">·</span>
          <span className="text-text-muted">{count} selected</span>
          <span className="text-text-faint">·</span>
          {unreadSelected.length > 0 && (
            <button
              onClick={() => onBulkAction("markRead", [...selectedIds])}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-text-secondary"
              title={`Mark ${count} as read`}
            >
              <Check size={13} />
              Read
            </button>
          )}
          <button
            onClick={() => onBulkAction("archive", [...selectedIds])}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-text-secondary"
            title={`Archive ${count} sessions`}
          >
            <Archive size={13} />
            Archive
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete ${count} session${count === 1 ? "" : "s"}? This cannot be undone.`)) {
                onBulkAction("delete", [...selectedIds]);
              }
            }}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-error"
            title={`Delete ${count} sessions`}
          >
            <Trash2 size={13} />
            Delete
          </button>
        </>
      )}
    </div>
  );
}

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
  // Session duplication
  onDuplicateSession?: (sessionId: string) => void;
  // Session reload
  onReloadSession?: (sessionId: string) => void;
  // Mark unread
  onMarkUnread?: (sessionId: string) => void;
  // Draft indicator
  hasDraft?: (sessionId: string) => boolean;
  exitingIds?: Set<string>;
  className?: string;
  // Multi-select / bulk actions
  selectMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (sessionId: string) => void;
  onBulkAction?: (action: BatchAction, sessionIds: string[]) => void;
  // Lazy-load archived sessions
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
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
  onDuplicateSession,
  onReloadSession,
  onMarkUnread,
  hasDraft,
  exitingIds,
  className,
  selectMode,
  selectedIds,
  onToggleSelect,
  onBulkAction,
  onRequestArchived,
  archivedLoaded,
}: SessionListProps) {
  const s = styles[variant];
  const [showArchived, setShowArchived] = useState(false);
  const { bind: bindLongPress, menu: ctxMenu, closeMenu: rawCloseMenu, isTarget } = useLongPressMenu<string>();
  const [copied, setCopied] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState<string | null>(null);

  const closeMenu = useCallback(() => { rawCloseMenu(); setCopied(false); }, [rawCloseMenu]);

  const ctxSession = ctxMenu ? sessions.find((ss) => ss.sessionId === ctxMenu.id) : null;

  // Find which task (if any) the context-menu'd session is linked to
  const ctxLinkedTask = ctxMenu && tasks
    ? tasks.find((t) => t.sessionIds.includes(ctxMenu.id))
    : null;

  const activeSessions = sessions.filter((sess) => !sess.archived && !archivingIds?.has(sess.sessionId));
  const archivedSessions = sessions.filter((sess) => sess.archived);

  const renderItem = (session: Session) => {
    const id = session.sessionId;
    const isActive = id === activeSessionId;
    const unread = !isActive && isUnread?.(id, getSessionActivityTime(session));
    const isArch = session.archived;
    const isArchiving = archivingIds?.has(id);
    const isExiting = exitingIds?.has(id);
    const isSelected = selectedIds?.has(id);
    const dotColor = isArchiving
      ? ""
      : session.busy
        ? "bg-info animate-pulse"
        : unread
          ? "bg-success"
          : isArch
            ? "bg-text-faint"
            : "bg-text-faint";

    const handleClick = selectMode && onToggleSelect
      ? () => onToggleSelect(id)
      : undefined;

    return (
      <div key={id} className={`group relative min-w-0${isExiting ? " animate-session-exit" : ""}`}>
        <button
          {...(selectMode ? { onClick: handleClick } : bindLongPress(id, () => onSelectSession(id)))}
          title={session.summary || id}
          className={`w-full min-w-0 overflow-hidden text-left px-3 ${s.itemPadding} rounded-md text-sm select-none no-callout transition-all duration-150 ${
            selectMode && isSelected
              ? "bg-accent/10 ring-1 ring-accent/30"
              : ctxMenu?.id === id
                ? "bg-bg-hover ring-1 ring-border"
                : isActive
                  ? "bg-bg-hover"
                  : "hover:bg-bg-hover"
          } ${isTarget(id) ? "scale-[0.97] bg-bg-hover" : ""} ${isArch || isArchiving ? "opacity-50" : ""}`}
        >
          <div className={`${unread ? s.titleClass.replace("font-medium", "font-semibold") : s.titleClass} flex items-center min-w-0`}>
            {selectMode ? (
              isSelected
                ? <SquareCheckBig size={14} className="text-accent shrink-0 mr-1.5" />
                : <Square size={14} className="text-text-muted shrink-0 mr-1.5" />
            ) : isArchiving ? (
              <Loader2 size={10} className={`${s.dotSize} animate-spin text-text-muted shrink-0`} />
            ) : (
              <span
                className={`inline-block ${s.dotSize} ${dotColor} rounded-full shrink-0`}
              />
            )}
            {session.triggeredBy === "schedule" && session.scheduleEnabled && (
              <Clock size={10} className="text-accent shrink-0 mr-0.5" title={`Scheduled: ${session.scheduleName ?? ""}`} />
            )}
            <span className="truncate">
              {session.summary || id.slice(0, 8)}
            </span>
          </div>
          <div className={`${s.metaClass} truncate`}>
            {isArchiving ? "Archiving…" : timeAgo(getSessionActivityTime(session))}
            {session.context?.branch && ` · ${session.context.branch}`}
            {session.diskSizeBytes
              ? ` · ${formatSize(session.diskSizeBytes)}`
              : ""}
            {session.hasPlan && " · "}
            {session.hasPlan && <ClipboardList size={10} className="inline" />}
            {hasDraft?.(id) && " · "}
            {hasDraft?.(id) && <Pencil size={10} className="inline text-warning" title="Has draft" />}
          </div>
        </button>
      </div>
    );
  };

  return (
    <div className={className ?? s.wrapper}>
      {!selectMode && (
        <button onClick={onNewSession} className={s.newButton}>
          {newButtonLabel}
        </button>
      )}
      {selectMode && onBulkAction && selectedIds && onToggleSelect && (
        <BulkActionBar
          activeSessions={activeSessions}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onBulkAction={onBulkAction}
          isUnread={isUnread}
        />
      )}
      {showEmptyState && activeSessions.length === 0 && archivedSessions.length === 0 && archivedLoaded !== false ? (
        <div className="text-xs text-text-faint px-3 py-1">No sessions yet</div>
      ) : (
        <>
          <div className={s.listGap}>
            {activeSessions.map(renderItem)}
          </div>
          {(archivedSessions.length > 0 || (onRequestArchived && !archivedLoaded)) && (
            <>
              <button
                onClick={() => {
                  const next = !showArchived;
                  setShowArchived(next);
                  if (next && onRequestArchived && !archivedLoaded) onRequestArchived();
                }}
                className="w-full px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors mt-2 flex items-center gap-1"
              >
                {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Archived{archivedLoaded !== false ? ` (${archivedSessions.length})` : ""}
              </button>
              {showArchived && (
                <div className={s.listGap}>
                  {!archivedLoaded && archivedSessions.length === 0 ? (
                    <div className="text-xs text-text-faint px-3 py-1">Loading…</div>
                  ) : (
                    archivedSessions.map(renderItem)
                  )}
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
              navigator.clipboard.writeText(ctxMenu.id);
              setCopied(true);
              setTimeout(closeMenu, 600);
            }}
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy Session ID"}
          </button>
          {onDuplicateSession && ctxSession && (
            <CtxItem
              icon={<CopyPlus size={14} />}
              label="Duplicate"
              disabled={ctxSession.busy}
              onClick={() => {
                onDuplicateSession(ctxMenu.id);
                closeMenu();
              }}
            />
          )}
          {onArchiveSession && ctxSession && (
            <CtxItem
              icon={ctxSession.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              label={ctxSession.archived ? "Unarchive" : "Archive"}
              onClick={() => {
                onArchiveSession(ctxMenu.id, !ctxSession.archived);
                closeMenu();
              }}
            />
          )}
          {onReloadSession && ctxSession && (
            <CtxItem
              icon={<RotateCw size={14} />}
              label="Reload MCPs"
              disabled={ctxSession.busy}
              onClick={() => {
                onReloadSession(ctxMenu.id);
                closeMenu();
              }}
            />
          )}
          {onMarkUnread && ctxSession && !isUnread?.(ctxMenu.id, getSessionActivityTime(ctxSession)) && (
            <CtxItem
              icon={<EyeOff size={14} />}
              label="Mark Unread"
              onClick={() => {
                onMarkUnread(ctxMenu.id);
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
                  const sid = ctxMenu.id;
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
                onUnlinkFromTask(ctxMenu.id, taskContext.id);
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
                  onDeleteSession(ctxMenu.id);
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
