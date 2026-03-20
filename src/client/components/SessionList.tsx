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
}: SessionListProps) {
  const s = styles[variant];

  return (
    <div className={s.wrapper}>
      <button onClick={onNewSession} className={s.newButton}>
        {newButtonLabel}
      </button>
      {showEmptyState && sessions.length === 0 ? (
        <div className="text-xs text-gray-600 px-3 py-1">No sessions yet</div>
      ) : (
        <div className={s.listGap}>
          {sessions.map((session) => {
            const id = session.sessionId;
            const isActive = id === activeSessionId;
            const unread = !isActive && isUnread?.(id, session.modifiedTime);
            // Dot: busy (blue pulsing) > unread (green solid) > idle (gray)
            const dotColor = session.busy
              ? "bg-blue-400 animate-pulse"
              : unread
                ? "bg-green-400"
                : "bg-gray-600";
            return (
              <button
                key={id}
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
                }`}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
