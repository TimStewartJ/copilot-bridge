import { useState } from "react";
import type { Session } from "../api";

type LinkType = "session" | "workItem" | "pr";

interface LinkDialogProps {
  sessions: Session[];
  onLink: (resource: any) => void;
  onClose: () => void;
}

export default function LinkDialog({
  sessions,
  onLink,
  onClose,
}: LinkDialogProps) {
  const [linkType, setLinkType] = useState<LinkType>("workItem");
  const [workItemId, setWorkItemId] = useState("");
  const [repoName, setRepoName] = useState("");
  const [prId, setPrId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");

  const handleSubmit = () => {
    switch (linkType) {
      case "workItem":
        if (!workItemId) return;
        onLink({ type: "workItem", workItemId: Number(workItemId) });
        break;
      case "pr":
        if (!repoName || !prId) return;
        onLink({
          type: "pr",
          repoId: repoName,
          repoName,
          prId: Number(prId),
        });
        break;
      case "session":
        if (!selectedSessionId) return;
        onLink({ type: "session", sessionId: selectedSessionId });
        break;
    }
  };

  const filteredSessions = sessions.filter(
    (s) =>
      !sessionSearch ||
      (s.summary || "").toLowerCase().includes(sessionSearch.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg w-[480px] max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#2a2a4a]">
          <h3 className="font-semibold text-sm">Link Resource</h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300"
          >
            ✕
          </button>
        </div>

        {/* Type Tabs */}
        <div className="flex border-b border-[#2a2a4a]">
          {(
            [
              ["workItem", "📋 Work Item"],
              ["pr", "🔀 Pull Request"],
              ["session", "💬 Session"],
            ] as const
          ).map(([type, label]) => (
            <button
              key={type}
              onClick={() => setLinkType(type)}
              className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${
                linkType === type
                  ? "text-indigo-400 border-b-2 border-indigo-400"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {linkType === "workItem" && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Work Item ID
              </label>
              <input
                type="number"
                value={workItemId}
                onChange={(e) => setWorkItemId(e.target.value)}
                placeholder="e.g., 12345"
                autoFocus
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded-md text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
          )}

          {linkType === "pr" && (
            <>
              <div>
                <label className="text-xs text-gray-400 block mb-1">
                  Repository Name
                </label>
                <input
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder="e.g., my-repo"
                  autoFocus
                  className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded-md text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">
                  PR Number
                </label>
                <input
                  type="number"
                  value={prId}
                  onChange={(e) => setPrId(e.target.value)}
                  placeholder="e.g., 1234"
                  className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded-md text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
            </>
          )}

          {linkType === "session" && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Search Sessions
              </label>
              <input
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
                placeholder="Filter by summary..."
                autoFocus
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded-md text-sm focus:outline-none focus:border-indigo-500 mb-2"
              />
              <div className="max-h-[200px] overflow-y-auto space-y-1">
                {filteredSessions.map((s) => (
                  <button
                    key={s.sessionId}
                    onClick={() => setSelectedSessionId(s.sessionId)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      selectedSessionId === s.sessionId
                        ? "bg-indigo-500/20 border border-indigo-500/30"
                        : "bg-[#1a1a2e] hover:bg-[#2a2a4a]"
                    }`}
                  >
                    <div className="truncate">
                      {s.summary || s.sessionId.slice(0, 8)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-[#2a2a4a]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm rounded-md transition-colors"
          >
            Link
          </button>
        </div>
      </div>
    </div>
  );
}
