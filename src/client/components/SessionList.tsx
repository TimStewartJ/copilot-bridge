import { useState } from "react";
import type { Session } from "../api";

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
      "w-full px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm rounded-md transition-colors",
    itemPadding: "py-2.5",
    titleClass: "font-medium truncate",
    metaClass: "text-xs text-gray-500 mt-0.5",
    dotSize: "w-2 h-2 mr-1.5",
    listGap: "space-y-1",
  },
  compact: {
    wrapper: "",
    newButton:
      "w-full mb-1.5 px-3 py-1.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-md text-xs hover:bg-indigo-500/30 transition-colors",
    itemPadding: "py-2",
    titleClass: "font-medium truncate text-xs",
    metaClass: "text-[10px] text-gray-500 mt-0.5",
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
      ? "bg-blue-400 animate-pulse"
      : unread
        ? "bg-green-400"
        : isArch
          ? "bg-gray-700"
          : "bg-gray-600";

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
              ? "bg-[#2a2a5e] border-l-3 border-indigo-400"
              : "hover:bg-[#1a1a3e]"
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
            {session.hasPlan && " · 📋"}
          </div>
        </button>
        {onArchiveSession && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchiveSession(id, !isArch);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-yellow-400 transition-all text-xs px-1.5 py-0.5 rounded"
            title={isArch ? "Unarchive session" : "Archive session"}
          >
            {isArch ? "📤" : "📦"}
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
        <div className="text-xs text-gray-600 px-3 py-1">No sessions yet</div>
      ) : (
        <>
          <div className={s.listGap}>
            {activeSessions.map(renderItem)}
          </div>
          {archivedSessions.length > 0 && (
            <>
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="w-full px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors mt-2"
              >
                {showArchived ? "▾" : "▸"} Archived ({archivedSessions.length})
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
