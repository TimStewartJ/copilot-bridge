import { useState, useCallback, useEffect, useRef } from "react";
import {
  getSessionActivityTime,
  getSessionRunState,
  isSessionActive,
  fetchModels,
  type BatchAction,
  type ModelInfo,
  type Session,
  type SessionModelState,
  type Task,
} from "../api";
import { queryClient, queryKeys } from "../queryClient";
import { writeClipboardText } from "../lib/clipboard";
import { timeAgo } from "../time";
import { ChevronDown, ChevronRight, Archive, ArchiveRestore, ClipboardList, Copy, Check, CheckCheck, Link, Unlink, Loader2, Trash2, Clock, EyeOff, Pencil, GitFork, Plus, Square, SquareCheckBig, RotateCw, Bot, Terminal } from "lucide-react";
import { DS } from "../design/tokens";
import { Button, StatusIcon } from "../design/primitives";
import TaskPickerDialog from "./TaskPickerDialog";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import useLongPressMenu from "../hooks/useLongPressMenu";
import { LoadingSkeletonRegion, SkeletonRow } from "./shared/Skeleton";
import { hasSurfacedBackgroundAgents } from "../../shared/session-agents.js";
import { useQuery } from "@tanstack/react-query";
import { useSessionModelQuery } from "../hooks/queries/useSessionModel";
import { formatSessionModelLabel } from "../lib/session-model";
import DeferredWorkSheet from "./DeferredWorkSheet";
import SessionModelDialog, { canKeepCurrentReasoningEffortForModel } from "./SessionModelDialog";

/** A session log this large is worth noticing; smaller ones keep their size in the tooltip only. */
export const LARGE_SESSION_LOG_BYTES = 50 * 1024 * 1024;
/** Archived rows are drawn this many at a time; a task can hold thousands. */
export const ARCHIVED_SESSION_RENDER_PAGE = 25;

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDeferSummaryLabel(deferSummary?: Session["deferSummary"]): string | null {
  const count = deferSummary?.count ?? 0;
  if (count <= 0) return null;

  const runningCount = Math.min(count, Math.max(0, deferSummary?.runningCount ?? 0));
  if (runningCount > 0) {
    if (runningCount === count) {
      return count === 1 ? "Defer running" : `${count} defers running`;
    }
    return `${runningCount} running · ${count - runningCount} queued`;
  }

  const nextRun = deferSummary?.nextRunAt ? timeAgo(deferSummary.nextRunAt) : null;
  if (count === 1) {
    return nextRun ? `Deferred ${nextRun}` : "Deferred";
  }

  return nextRun ? `${count} defers · next ${nextRun}` : `${count} defers`;
}

function getSessionModelSourceLabel(source?: SessionModelState["source"]): string {
  switch (source) {
    case "live": return "Live session";
    case "events": return "Saved in session history";
    case "unknown": return "No saved model state";
    default: return "Checking session model";
  }
}

export { canKeepCurrentReasoningEffortForModel };

const styles = {
  global: {
    wrapper: "flex-1 overflow-y-auto overflow-x-hidden min-w-0 p-2 space-y-1",
    newButton: `${DS.button.base} ${DS.button.size.md} ${DS.button.variant.secondary} w-full`,
    itemPadding: "py-2.5",
    titleClass: "font-medium truncate",
    metaClass: "text-xs text-text-muted mt-0.5",
    dotSize: "size-3 mr-1.5",
    /** Lines the meta row up with the title, past the status slot. */
    metaIndent: "pl-[18px]",
    deferIndent: "left-[30px]",
    listGap: "space-y-1",
  },
  compact: {
    wrapper: "min-w-0 overflow-x-hidden",
    newButton: `${DS.button.base} ${DS.button.size.sm} ${DS.button.variant.secondary} mb-1.5 w-full`,
    itemPadding: "py-2",
    titleClass: "font-medium truncate text-[13px]",
    metaClass: "text-[11px] text-text-muted mt-0.5",
    dotSize: "size-3 mr-1",
    metaIndent: "pl-4",
    deferIndent: "left-7",
    listGap: "space-y-0.5",
  },
} as const;

/** A "+ New chat" label with the plus drawn as an icon, so the button matches every other create action. */
function NewLabel({ label }: { label: string }) {
  const text = label.replace(/^\+\s*/, "");
  return (
    <>
      {text !== label && <Plus size={14} aria-hidden="true" />}
      {text}
    </>
  );
}

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
  // Session fork
  onForkSession?: (sessionId: string) => Promise<void> | void;
  // Session reload
  onReloadSession?: (sessionId: string) => void;
  // Mark unread
  onMarkUnread?: (sessionId: string) => void;
  onMarkAllRead?: () => void;
  // Draft indicator
  hasDraft?: (sessionId: string) => boolean;
  exitingIds?: Set<string>;
  className?: string;
  // Bulk actions
  onBulkAction?: (action: BatchAction, sessionIds: string[]) => void;
  // Lazy-load archived sessions
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
  /** How many archived sessions exist when the caller loads them a page at a time. */
  archivedTotal?: number;
  /** Fetches the next page of archived sessions; called when the drawn rows run out. */
  onLoadMoreArchived?: () => void;
  archivedLoadingMore?: boolean;
  /** Loading archived sessions failed; offer a retry instead of an endless skeleton or an empty list. */
  archivedError?: boolean;
  onRetryArchived?: () => void;
  // Hide the new-session button (e.g. when the parent already provides one)
  showNewButton?: boolean;
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
  onForkSession,
  onReloadSession,
  onMarkUnread,
  onMarkAllRead,
  hasDraft,
  exitingIds,
  className,
  onBulkAction,
  onRequestArchived,
  archivedLoaded,
  archivedLoading = false,
  archivedTotal,
  onLoadMoreArchived,
  archivedLoadingMore = false,
  archivedError = false,
  onRetryArchived,
  showNewButton = true,
}: SessionListProps) {
  const s = styles[variant];
  const [showArchived, setShowArchived] = useState(false);
  const [archivedRenderLimit, setArchivedRenderLimit] = useState(ARCHIVED_SESSION_RENDER_PAGE);
  const { bind: bindLongPress, menu: ctxMenu, closeMenu: rawCloseMenu, isTarget } = useLongPressMenu<string>();
  const [copied, setCopied] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [modelDialogSessionId, setModelDialogSessionId] = useState<string | null>(null);
  const [deferredWorkSessionId, setDeferredWorkSessionId] = useState<string | null>(null);
  const [deferredWorkRestoreFocus, setDeferredWorkRestoreFocus] = useState<HTMLElement | null>(null);
  const sessionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [menuError, setMenuError] = useState<string | null>(null);
  const copyRequestRef = useRef(0);

  const closeMenu = useCallback(() => {
    copyRequestRef.current += 1;
    rawCloseMenu();
    setCopied(false);
    setMenuError(null);
  }, [rawCloseMenu]);

  const ctxSession = ctxMenu ? sessions.find((ss) => ss.sessionId === ctxMenu.id) : null;

  // Find which task (if any) the context-menu'd session is linked to
  const ctxLinkedTask = ctxMenu && tasks
    ? tasks.find((t) => t.sessionIds.includes(ctxMenu.id))
    : null;
  const canSelectFromMenu = !!onBulkAction && !!ctxSession && !ctxSession.archived;
  const canReloadFromMenu = !!onReloadSession && !!ctxSession;
  const canForkFromMenu = !!onForkSession && !!ctxSession;
  const canArchiveFromMenu = !!onArchiveSession && !!ctxSession;
  const canMarkUnreadFromMenu = !!ctxSession
    && !!onMarkUnread
    && !isUnread?.(ctxSession.sessionId, getSessionActivityTime(ctxSession));
  const canLinkToTaskFromMenu = !!ctxSession && !taskContext && !!onLinkToTask && !!tasks;
  const canUnlinkFromTaskFromMenu = !!ctxSession && !!taskContext && !!onUnlinkFromTask;
  const canDeleteFromMenu = !!onDeleteSession && !!ctxSession;
  const hasEditSection =
    canForkFromMenu
    || canArchiveFromMenu
    || canMarkUnreadFromMenu
    || canLinkToTaskFromMenu
    || canUnlinkFromTaskFromMenu;

  const activeSessions = sessions.filter((sess) => !sess.archived && !archivingIds?.has(sess.sessionId));
  const archivedSessions = sessions.filter((sess) => sess.archived);
  const archivedCount = Math.max(archivedTotal ?? 0, archivedSessions.length);
  const archivedRemaining = Math.max(0, archivedCount - Math.min(archivedRenderLimit, archivedSessions.length));
  const ctxModelQuery = useSessionModelQuery(ctxSession?.sessionId);
  // Names models for the context menu from whatever the app already loaded; it never fetches.
  const cachedModelsQuery = useQuery<ModelInfo[]>({
    queryKey: queryKeys.models,
    queryFn: fetchModels,
    enabled: false,
  }, queryClient);
  const modelDialogSession = modelDialogSessionId
    ? sessions.find((session) => session.sessionId === modelDialogSessionId)
    : null;
  const unreadCount = activeSessions.filter(
    (session) => !session.archived && isUnread?.(session.sessionId, getSessionActivityTime(session)),
  ).length;
  const showQuickChatHeader = !!onMarkAllRead;

  useEffect(() => {
    const validSessions = selectMode ? activeSessions : sessions;
    const validIds = new Set(validSessions.map((session) => session.sessionId));
    if (anchorRef.current && !validIds.has(anchorRef.current)) {
      anchorRef.current = null;
    }
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [activeSessions, selectMode, sessions]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, []);

  const openModelDialog = useCallback((sessionId: string) => {
    setModelDialogSessionId(sessionId);
    closeMenu();
  }, [closeMenu]);

  const closeModelDialog = useCallback(() => {
    setModelDialogSessionId(null);
  }, []);

  const handleBulkAction = useCallback((action: BatchAction, ids: string[]) => {
    onBulkAction?.(action, ids);
    exitSelectMode();
  }, [onBulkAction, exitSelectMode]);

  const renderItem = (session: Session) => {
    const id = session.sessionId;
    const isActive = id === activeSessionId;
    const unread = !isActive && isUnread?.(id, getSessionActivityTime(session));
    const isArch = session.archived;
    const isArchiving = archivingIds?.has(id);
    const isExiting = exitingIds?.has(id);
    const isSelected = selectedIds?.has(id);
    const needsUserInput = session.needsUserInput || (session.pendingUserInputCount ?? 0) > 0;
    const deferLabel = formatDeferSummaryLabel(session.deferSummary);
    const deferRunning = (session.deferSummary?.runningCount ?? 0) > 0;
    const backgroundAgents = session.backgroundAgents;
    const showBackgroundAgents = hasSurfacedBackgroundAgents(backgroundAgents);
    const backgroundAgentsRunning = (backgroundAgents?.running ?? 0) > 0;
    const backgroundAgentsTitle = showBackgroundAgents
      ? `${(backgroundAgents!.running + backgroundAgents!.idle)} background agent${
          backgroundAgents!.running + backgroundAgents!.idle === 1 ? "" : "s"
        }${backgroundAgents!.running ? ` · ${backgroundAgents!.running} running` : ""}${
          backgroundAgents!.idle ? ` · ${backgroundAgents!.idle} idle` : ""
        }`
      : undefined;
    const runState = getSessionRunState(session);
    const status = needsUserInput
      ? { kind: "needs-input" as const, label: "Needs your input" }
      : runState === "stalled"
        ? { kind: "warning" as const, label: "Stalled" }
        : runState === "busy"
          ? { kind: "working" as const, label: "Working" }
          : unread
            ? { kind: "unread" as const, label: "New results" }
            : null;
    const { onClick: guardedClick, ...longPressBindings } = bindLongPress(id, () => onSelectSession(id));

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      const canBulkSelect = !!onBulkAction && !session.archived;
      const isToggleKey = canBulkSelect && (e.metaKey || e.ctrlKey);
      const isRangeKey = canBulkSelect && e.shiftKey;

      if (isRangeKey) {
        e.preventDefault();
        setSelectMode(true);
        const anchorIndex = anchorRef.current
          ? activeSessions.findIndex((activeSession) => activeSession.sessionId === anchorRef.current)
          : -1;
        const currentIndex = activeSessions.findIndex((activeSession) => activeSession.sessionId === id);
        if (anchorIndex >= 0 && currentIndex >= 0) {
          const start = Math.min(anchorIndex, currentIndex);
          const end = Math.max(anchorIndex, currentIndex);
          const rangeIds = activeSessions.slice(start, end + 1).map((activeSession) => activeSession.sessionId);
          setSelectedIds((prev) => {
            if (isToggleKey) {
              const next = new Set(prev);
              for (const rangeId of rangeIds) next.add(rangeId);
              return next;
            }
            return new Set(rangeIds);
          });
          return;
        }
        setSelectedIds((prev) => {
          if (isToggleKey) {
            const next = new Set(prev);
            next.add(id);
            return next;
          }
          return new Set([id]);
        });
        anchorRef.current = id;
        return;
      }

      if (isToggleKey) {
        e.preventDefault();
        setSelectMode(true);
        toggleSelect(id);
        anchorRef.current = id;
        return;
      }

      if (selectMode && onBulkAction) {
        toggleSelect(id);
        anchorRef.current = id;
        return;
      }

      guardedClick();
      if (!session.archived) anchorRef.current = id;
    };

    return (
      <div key={id} className={`group relative min-w-0${isExiting ? " animate-session-exit" : ""}`}>
        <button
          ref={(element) => {
            if (element) {
              sessionButtonRefs.current.set(id, element);
            } else {
              sessionButtonRefs.current.delete(id);
            }
          }}
          {...(selectMode ? {} : longPressBindings)}
          onClick={handleClick}
          title={[
            session.summary || id,
            session.eventLogSizeBytes ? formatSize(session.eventLogSizeBytes) : null,
          ].filter(Boolean).join(" · ")}
          className={`w-full min-w-0 overflow-hidden text-left px-3 ${s.itemPadding} rounded-md text-sm select-none no-callout transition-all duration-150 ${
            selectMode && isSelected
              ? "bg-bg-hover ring-1 ring-border"
              : ctxMenu?.id === id
                ? "bg-bg-hover ring-1 ring-border"
                : isActive
                  ? "bg-bg-hover"
                  : "hover:bg-bg-hover"
          } ${isTarget(id) ? "scale-[0.97] bg-bg-hover" : ""} ${isArch || isArchiving ? "opacity-50" : ""} ${
            deferLabel && !selectMode ? "pb-11 md:pb-8" : ""
          }`}
        >
          <div className={`${unread ? s.titleClass.replace("font-medium", "font-semibold") : s.titleClass} flex items-center min-w-0`}>
            {selectMode ? (
              isSelected
                ? <SquareCheckBig size={14} className="text-accent shrink-0 mr-1.5" />
                : <Square size={14} className="text-text-muted shrink-0 mr-1.5" />
            ) : isArchiving ? (
              <Loader2 size={10} className={`${s.dotSize} animate-spin text-text-muted shrink-0`} />
            ) : showBackgroundAgents ? (
              <span title={backgroundAgentsTitle} className={`inline-flex ${s.dotSize} shrink-0 items-center justify-center`}>
                <Bot
                  size={12}
                  className={`text-agent shrink-0${backgroundAgentsRunning ? " animate-pulse" : ""}`}
                />
              </span>
            ) : (
              <span className={`inline-flex ${s.dotSize} shrink-0 items-center justify-center`}>
                {status && <StatusIcon kind={status.kind} label={status.label} />}
              </span>
            )}
            {session.triggeredBy === "schedule" && session.scheduleEnabled && (
              <span title={`Scheduled: ${session.scheduleName ?? ""}`} className="inline-flex shrink-0 mr-0.5">
                <Clock size={10} className="text-accent" />
              </span>
            )}
            <span className="truncate">
              {session.summary || id.slice(0, 8)}
            </span>
          </div>
          <div className={`${s.metaClass} ${selectMode ? "pl-5" : s.metaIndent} truncate`}>
            {isArchiving ? "Archiving…" : needsUserInput ? "Needs answer" : timeAgo(getSessionActivityTime(session))}
            {session.externallyInUse && (
              <>
                {" · "}
                <span
                  className="inline-flex items-center gap-0.5 align-middle font-medium text-info"
                  title="This session is open in another Copilot client"
                >
                  <Terminal size={9} className="shrink-0" aria-hidden="true" />
                  <span>Open elsewhere</span>
                </span>
              </>
            )}
            {session.context?.branch && ` · ${session.context.branch}`}
            {session.eventLogSizeBytes && session.eventLogSizeBytes >= LARGE_SESSION_LOG_BYTES
              ? ` · ${formatSize(session.eventLogSizeBytes)}`
              : ""}
            {session.workspace?.overridesTaskWorkspace && (
              <>
                {" · "}
                <span className="text-warning">Overrides task workspace</span>
              </>
            )}
            {session.hasPlan && " · "}
            {session.hasPlan && <ClipboardList size={10} className="inline" />}
            {hasDraft?.(id) && " · "}
            {hasDraft?.(id) && (
              <span title="Has draft">
                <Pencil size={10} className="inline text-warning" />
              </span>
            )}
          </div>
        </button>
        {deferLabel && !selectMode && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setDeferredWorkRestoreFocus(
                sessionButtonRefs.current.get(id) ?? event.currentTarget,
              );
              setDeferredWorkSessionId(id);
            }}
            className={`absolute bottom-1.5 ${s.deferIndent} inline-flex min-h-8 max-w-[calc(100%-2.5rem)] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors md:min-h-0 ${
              deferRunning
                ? "bg-info-surface text-info hover:bg-info/20"
                : "bg-bg-hover text-text-secondary hover:text-text-primary"
            } ${
              isArch || isArchiving ? "opacity-50" : ""
            }`}
            title={`${deferLabel}. Open deferred work.`}
          >
            {deferRunning
              ? <Loader2 size={9} className="shrink-0 animate-spin" aria-hidden="true" />
              : <Clock size={9} className="shrink-0" aria-hidden="true" />}
            <span className="truncate">{deferLabel}</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={className ?? s.wrapper}>
      {selectMode ? (
        <div className="flex items-center gap-1 mb-1">
          <button
            type="button"
            onClick={exitSelectMode}
            className={`${DS.button.base} ${DS.button.size.sm} ${DS.button.variant.secondary}`}
          >
            Done
          </button>
        </div>
      ) : showQuickChatHeader ? (
        <div className="flex items-center gap-1 mb-1">
          {showNewButton && (
            <button
              type="button"
              onClick={onNewSession}
              className={`${DS.button.base} ${DS.button.size.md} ${DS.button.variant.secondary} flex-1`}
            >
              <NewLabel label={newButtonLabel} />
            </button>
          )}
          {unreadCount > 0 && (
            <button
              onClick={onMarkAllRead}
              className={`${DS.button.base} ${DS.button.icon.md} ${DS.button.variant.ghost}`}
              aria-label="Mark all as read"
              title="Mark all as read"
            >
              <CheckCheck size={14} />
            </button>
          )}
        </div>
      ) : showNewButton ? (
        <button type="button" onClick={onNewSession} className={s.newButton}>
          <NewLabel label={newButtonLabel} />
        </button>
      ) : null}
      {selectMode && onBulkAction && (
        <BulkActionBar
          activeSessions={activeSessions}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onBulkAction={handleBulkAction}
          isUnread={isUnread}
        />
      )}
      {showEmptyState && activeSessions.length === 0 && archivedSessions.length === 0 && archivedLoaded !== false && !archivedLoading ? (
        <div className="text-xs text-text-faint px-3 py-1">No sessions yet</div>
      ) : (
        <>
          <div className={s.listGap}>
            {activeSessions.map(renderItem)}
          </div>
          {!selectMode && (archivedSessions.length > 0 || archivedLoading || (onRequestArchived && !archivedLoaded)) && (
            <>
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={() => {
                  const next = !showArchived;
                  setShowArchived(next);
                  if (!next) setArchivedRenderLimit(ARCHIVED_SESSION_RENDER_PAGE);
                  if (next && onRequestArchived && !archivedLoaded) onRequestArchived();
                }}
                className={`w-full px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors mt-2 flex items-center gap-1 ${DS.row.touch}`}
              >
                {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Archived{archivedLoaded !== false && !archivedLoading ? ` (${archivedCount})` : ""}
              </button>
              {showArchived && (
                <div className={s.listGap}>
                  {archivedError && archivedSessions.length === 0 ? (
                    <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-text-secondary">
                      <span>Archived sessions could not be loaded.</span>
                      {onRetryArchived && (
                        <Button size="sm" variant="ghost" onClick={onRetryArchived}>Retry</Button>
                      )}
                    </div>
                  ) : archivedSessions.length === 0 && (archivedLoading || !archivedLoaded) ? (
                    <LoadingSkeletonRegion
                      isLoading
                      label="Loading archived sessions"
                      className="px-1 py-1"
                    >
                      <div className="space-y-0.5">
                        {Array.from({ length: 3 }, (_, index) => (
                          <SkeletonRow
                            key={index}
                            leading={false}
                            className={`px-2 ${s.itemPadding}`}
                          />
                        ))}
                      </div>
                    </LoadingSkeletonRegion>
                  ) : (
                    <>
                      {archivedSessions.slice(0, archivedRenderLimit).map(renderItem)}
                      {archivedError && onRetryArchived && archivedRemaining > 0 && (
                        <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-text-secondary">
                          <span>More archived sessions could not be loaded.</span>
                          <Button size="sm" variant="ghost" onClick={onRetryArchived}>Retry</Button>
                        </div>
                      )}
                      {!archivedError && archivedRemaining > 0 && (
                        <button
                          type="button"
                          disabled={archivedLoadingMore}
                          onClick={() => {
                            const nextLimit = archivedRenderLimit + ARCHIVED_SESSION_RENDER_PAGE;
                            setArchivedRenderLimit(nextLimit);
                            if (onLoadMoreArchived && archivedSessions.length < nextLimit) onLoadMoreArchived();
                          }}
                          className={`w-full px-3 py-1.5 text-left text-xs text-text-muted hover:text-text-secondary transition-colors disabled:text-text-faint ${DS.row.touch}`}
                        >
                          {archivedLoadingMore
                            ? "Loading…"
                            : `Show ${Math.min(ARCHIVED_SESSION_RENDER_PAGE, archivedRemaining)} more · ${archivedRemaining} left`}
                        </button>
                      )}
                    </>
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
          {canSelectFromMenu && (
            <CtxItem
              icon={<SquareCheckBig size={14} />}
              label="Select"
              onClick={() => {
                setSelectMode(true);
                setSelectedIds(new Set([ctxMenu.id]));
                anchorRef.current = ctxMenu.id;
                closeMenu();
              }}
            />
          )}
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              const sessionId = ctxMenu.id;
              const requestId = copyRequestRef.current + 1;
              copyRequestRef.current = requestId;
              setCopied(false);
              setMenuError(null);
              void writeClipboardText(sessionId).then(() => {
                if (copyRequestRef.current !== requestId) return;
                setCopied(true);
                setTimeout(() => {
                  if (copyRequestRef.current !== requestId) return;
                  closeMenu();
                }, 600);
              }, (error) => {
                if (copyRequestRef.current !== requestId) return;
                setMenuError(`Copy failed: ${getErrorMessage(error)}`);
              });
            }}
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy Session ID"}
          </button>
          {ctxSession && (
            <CtxItem
              icon={<Clock size={14} />}
              label="Deferred Work..."
              onClick={() => {
                setDeferredWorkRestoreFocus(
                  sessionButtonRefs.current.get(ctxSession.sessionId) ?? null,
                );
                setDeferredWorkSessionId(ctxSession.sessionId);
                closeMenu();
              }}
            />
          )}
          {canReloadFromMenu && (
            <CtxItem
              icon={<RotateCw size={14} />}
              label="Reload MCPs"
              disabled={isSessionActive(ctxSession)}
              onClick={() => {
                onReloadSession(ctxSession.sessionId);
                closeMenu();
              }}
            />
          )}
          {ctxSession && (
            <>
              <CtxDivider />
              <div className="px-3 py-2 flex items-start gap-2 text-xs">
                <Bot size={14} className="shrink-0 text-text-muted mt-0.5" />
                <div className="min-w-0">
                  <div className="text-text-faint">Session model</div>
                  <div
                    className={`truncate ${ctxModelQuery.error ? "text-error" : "text-text-secondary"}`}
                    title={ctxModelQuery.error ? getErrorMessage(ctxModelQuery.error) : undefined}
                  >
                    {ctxModelQuery.error
                      ? "Unable to load model"
                      : formatSessionModelLabel(ctxModelQuery.data, cachedModelsQuery.data)}
                  </div>
                  <div className="text-[10px] text-text-faint">
                    {ctxModelQuery.isFetching && ctxModelQuery.data
                      ? "Refreshing..."
                      : getSessionModelSourceLabel(ctxModelQuery.data?.source)}
                  </div>
                </div>
              </div>
              <CtxItem
                icon={<Bot size={14} />}
                label="Change Model..."
                disabled={isSessionActive(ctxSession)}
                title={isSessionActive(ctxSession) ? "This session is busy" : "Change only this session's model"}
                onClick={() => {
                  openModelDialog(ctxSession.sessionId);
                }}
              />
            </>
          )}
          {(hasEditSection || canDeleteFromMenu) && <CtxDivider />}
          {canForkFromMenu && (
            <CtxItem
              icon={<GitFork size={14} />}
              label="Fork"
              disabled={isSessionActive(ctxSession)}
              title={isSessionActive(ctxSession) ? "This session is busy" : "Create a new branch from this session"}
              onClick={() => {
                setMenuError(null);
                void Promise.resolve(onForkSession(ctxSession.sessionId))
                  .then(closeMenu)
                  .catch((error) => setMenuError(`Fork failed: ${getErrorMessage(error)}`));
              }}
            />
          )}
          {menuError && (
            <div className="mx-3 my-2 text-xs text-error" role="alert">
              {menuError}
            </div>
          )}
          {canArchiveFromMenu && (
            <CtxItem
              icon={ctxSession.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              label={ctxSession.archived ? "Unarchive" : "Archive"}
              onClick={() => {
                onArchiveSession(ctxSession.sessionId, !ctxSession.archived);
                closeMenu();
              }}
            />
          )}
          {canMarkUnreadFromMenu && (
            <CtxItem
              icon={<EyeOff size={14} />}
              label="Mark Unread"
              onClick={() => {
                onMarkUnread(ctxSession.sessionId);
                closeMenu();
              }}
            />
          )}
          {/* Unlinked sessions: Link or move to task */}
          {canLinkToTaskFromMenu && (
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
                  const sid = ctxSession.sessionId;
                  closeMenu();
                  setShowTaskPicker(sid);
                }}
              />
            </>
          )}
          {/* Task-linked sessions: unlink from current task */}
          {canUnlinkFromTaskFromMenu && (
            <CtxItem
              icon={<Unlink size={14} />}
              label="Unlink from Task"
              className="text-warning"
              onClick={() => {
                onUnlinkFromTask(ctxSession.sessionId, taskContext.id);
                closeMenu();
              }}
            />
          )}
          {/* Delete session */}
          {hasEditSection && canDeleteFromMenu && <CtxDivider />}
          {canDeleteFromMenu && (
            <>
              <CtxItem
                icon={<Trash2 size={14} />}
                label="Delete"
                className="text-error"
                disabled={isSessionActive(ctxSession)}
                onClick={() => {
                  onDeleteSession(ctxSession.sessionId);
                  closeMenu();
                }}
              />
            </>
          )}
        </ContextMenu>
      )}

      {modelDialogSessionId && (
        <SessionModelDialog
          sessionId={modelDialogSessionId}
          sessionSummary={modelDialogSession?.summary}
          busy={!!modelDialogSession && isSessionActive(modelDialogSession)}
          onClose={closeModelDialog}
        />
      )}

      {deferredWorkSessionId && (
        <DeferredWorkSheet
          session={
            sessions.find((session) => session.sessionId === deferredWorkSessionId)
              ?? { sessionId: deferredWorkSessionId }
          }
          restoreFocusTo={deferredWorkRestoreFocus}
          onClose={() => {
            setDeferredWorkSessionId(null);
            setDeferredWorkRestoreFocus(null);
          }}
        />
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
