import { useState, useEffect, useCallback, useRef } from "react";
import type { Session } from "../api";
import { ChevronDown, ChevronRight, Archive, ArchiveRestore, ClipboardList, Copy, Check } from "lucide-react";

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
}: SessionListProps) {
  const s = styles[variant];
  const [showArchived, setShowArchived] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Long-press state for mobile
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);

  const closeMenu = useCallback(() => { setCtxMenu(null); setCopied(false); }, []);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDismiss = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
    document.addEventListener("mousedown", onDismiss);
    document.addEventListener("touchstart", onDismiss);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDismiss);
      document.removeEventListener("touchstart", onDismiss);
      document.removeEventListener("keydown", onEsc);
    };
  }, [ctxMenu, closeMenu]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const ctxSession = ctxMenu ? sessions.find((ss) => ss.sessionId === ctxMenu.sessionId) : null;

  const activeSessions = sessions.filter((sess) => !sess.archived);
  const archivedSessions = sessions.filter((sess) => sess.archived);

  const renderItem = (session: Session) => {
    const id = session.sessionId;
    const isActive = id === activeSessionId;
    const unread = !isActive && isUnread?.(id, session.modifiedTime);
    const isArch = session.archived;
    const dotColor = session.busy
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
            longPressTimer.current = setTimeout(() => {
              longPressTriggered.current = true;
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
          title={id}
          className={`w-full text-left px-3 ${s.itemPadding} rounded-md text-sm transition-colors ${
            isActive
              ? "bg-accent/10 border-l-2 border-accent"
              : "hover:bg-bg-hover"
          } ${isArch ? "opacity-50" : ""}`}
        >
          <div className={`${s.titleClass} flex items-center`}>
            <span
              className={`inline-block ${s.dotSize} ${dotColor} rounded-full shrink-0`}
            />
            <span className="truncate">
              {session.summary || id.slice(0, 8)}
            </span>
          </div>
          <div className={s.metaClass}>
            {timeAgo(session.modifiedTime)}
            {session.context?.branch && ` · ${session.context.branch}`}
            {session.diskSizeBytes
              ? ` · ${formatSize(session.diskSizeBytes)}`
              : ""}
            {session.hasPlan && " · "}
            {session.hasPlan && <ClipboardList size={10} className="inline" />}
          </div>
        </button>
        {onArchiveSession && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchiveSession(id, !isArch);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-text-muted hover:text-warning transition-all text-xs px-1.5 py-0.5 rounded"
            title={isArch ? "Unarchive session" : "Archive session"}
          >
            {isArch ? <ArchiveRestore size={12} /> : <Archive size={12} />}
          </button>
        )}
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
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] max-w-[calc(100vw-16px)] bg-bg-secondary border border-border rounded-lg shadow-lg py-1 text-sm"
          style={{
            top: Math.min(ctxMenu.y, window.innerHeight - 120),
            left: Math.min(ctxMenu.x, window.innerWidth - 196),
          }}
        >
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
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors"
              onClick={() => {
                onArchiveSession(ctxMenu.sessionId, !ctxSession.archived);
                closeMenu();
              }}
            >
              {ctxSession.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              {ctxSession.archived ? "Unarchive" : "Archive"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
