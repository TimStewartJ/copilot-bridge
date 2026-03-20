import { useState } from "react";
import type { Session } from "../api";
import { ChevronDown, ChevronRight, Archive, ArchiveRestore, ClipboardList } from "lucide-react";

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
          onClick={() => onSelectSession(id)}
          onContextMenu={(e) => {
            e.preventDefault();
            navigator.clipboard.writeText(id);
          }}
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
    </div>
  );
}
