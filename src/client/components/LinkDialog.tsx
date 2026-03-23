import { useState } from "react";
import type { Session, ProviderName } from "../api";
import { ClipboardList, GitPullRequest, MessageSquare, X } from "lucide-react";

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
  const [provider, setProvider] = useState<ProviderName>(
    () => (localStorage.getItem("bridge-last-provider") as ProviderName) || "ado",
  );
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");

  const handleProviderChange = (p: ProviderName) => {
    setProvider(p);
    localStorage.setItem("bridge-last-provider", p);
  };

  const handleSubmit = () => {
    switch (linkType) {
      case "workItem":
        if (!workItemId) return;
        onLink({ type: "workItem", workItemId: Number(workItemId), provider });
        break;
      case "pr":
        if (!repoName || !prId) return;
        onLink({
          type: "pr",
          repoId: repoName,
          repoName,
          prId: Number(prId),
          provider,
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border rounded-md w-full max-w-[480px] mx-4 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-medium text-sm">Link Resource</h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-secondary"
          >
            <X size={16} />
          </button>
        </div>

        {/* Type Tabs */}
        <div className="flex border-b border-border">
          {(
            [
              ["workItem", <ClipboardList size={12} />, "Work Item"],
              ["pr", <GitPullRequest size={12} />, "Pull Request"],
              ["session", <MessageSquare size={12} />, "Session"],
            ] as const
          ).map(([type, icon, label]) => (
            <button
              key={type}
              onClick={() => setLinkType(type)}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                linkType === type
                  ? "text-accent border-b-2 border-accent"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {(linkType === "workItem" || linkType === "pr") && (
            <div>
              <label className="text-xs text-text-muted block mb-1">
                Provider
              </label>
              <div className="flex gap-1">
                {(["ado", "github"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => handleProviderChange(p)}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      provider === p
                        ? "bg-accent/15 text-accent border border-accent/30"
                        : "bg-bg-primary text-text-muted border border-border hover:text-text-secondary"
                    }`}
                  >
                    {p === "ado" ? "Azure DevOps" : "GitHub"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {linkType === "workItem" && (
            <div>
              <label className="text-xs text-text-muted block mb-1">
                {provider === "github" ? "Issue Number" : "Work Item ID"}
              </label>
              <input
                type="number"
                value={workItemId}
                onChange={(e) => setWorkItemId(e.target.value)}
                placeholder={provider === "github" ? "e.g., 42" : "e.g., 12345"}
                autoFocus
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm focus:outline-none focus:border-accent"
              />
            </div>
          )}

          {linkType === "pr" && (
            <>
              <div>
                <label className="text-xs text-text-muted block mb-1">
                  Repository Name
                </label>
                <input
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder={provider === "github" ? "e.g., owner/repo" : "e.g., my-repo"}
                  autoFocus
                  className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">
                  PR Number
                </label>
                <input
                  type="number"
                  value={prId}
                  onChange={(e) => setPrId(e.target.value)}
                  placeholder="e.g., 1234"
                  className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm focus:outline-none focus:border-accent"
                />
              </div>
            </>
          )}

          {linkType === "session" && (
            <div>
              <label className="text-xs text-text-muted block mb-1">
                Search Sessions
              </label>
              <input
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
                placeholder="Filter by summary..."
                autoFocus
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm focus:outline-none focus:border-accent mb-2"
              />
              <div className="max-h-[200px] overflow-y-auto space-y-1">
                {filteredSessions.map((s) => (
                  <button
                    key={s.sessionId}
                    onClick={() => setSelectedSessionId(s.sessionId)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      selectedSessionId === s.sessionId
                        ? "bg-accent/15 border border-accent/30"
                        : "bg-bg-primary hover:bg-bg-hover"
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
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors"
          >
            Link
          </button>
        </div>
      </div>
    </div>
  );
}
