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

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: SidebarProps) {
  return (
    <div className="w-64 bg-[#16213e] border-r border-[#2a2a4a] flex flex-col shrink-0">
      <div className="p-4 border-b border-[#2a2a4a]">
        <h2 className="text-sm font-semibold text-indigo-400">🤖 Copilot Bridge</h2>
        <button
          onClick={onNewSession}
          className="w-full mt-3 px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm rounded-md transition-colors"
        >
          + New Session
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.map((s) => {
          const id = s.sessionId;
          const isActive = id === activeSessionId;
          return (
            <button
              key={id}
              onClick={() => onSelectSession(id)}
              className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-[#2a2a5e] border-l-3 border-indigo-400"
                  : "hover:bg-[#1a1a3e]"
              }`}
            >
              <div className="font-medium truncate">
                {s.summary || id.slice(0, 8)}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {timeAgo(s.modifiedTime)}
                {s.context?.branch && ` · ${s.context.branch}`}
                {s.diskSizeBytes ? ` · ${formatSize(s.diskSizeBytes)}` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
