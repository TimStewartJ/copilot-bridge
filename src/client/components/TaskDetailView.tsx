import { useState, useEffect, useCallback } from "react";
import {
  fetchTask,
  patchTask,
  deleteTask,
  linkResource,
  unlinkResource,
  createTaskSession,
  type Task,
  type Session,
} from "../api";
import NotesEditor from "./NotesEditor";
import LinkDialog from "./LinkDialog";

interface TaskDetailViewProps {
  taskId: string;
  sessions: Session[];
  onTaskUpdated: () => void;
  onTaskDeleted: () => void;
  onOpenSession: (sessionId: string) => void;
}

const STATUS_OPTIONS = ["active", "paused", "done", "archived"] as const;
const STATUS_STYLES = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  paused: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  done: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  archived: "bg-gray-700/20 text-gray-600 border-gray-700/30",
} as const;

export default function TaskDetailView({
  taskId,
  sessions,
  onTaskUpdated,
  onTaskDeleted,
  onOpenSession,
}: TaskDetailViewProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwdDraft, setCwdDraft] = useState("");

  const loadTask = useCallback(async () => {
    try {
      const t = await fetchTask(taskId);
      setTask(t);
      setTitleDraft(t.title);
      setCwdDraft(t.cwd || "");
    } catch (err) {
      console.error("Failed to load task:", err);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    loadTask();
  }, [loadTask]);

  if (loading || !task) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Loading task...
      </div>
    );
  }

  const handleStatusChange = async (status: Task["status"]) => {
    const updated = await patchTask(task.id, { status });
    setTask(updated);
    onTaskUpdated();
  };

  const handleTitleSave = async () => {
    if (titleDraft.trim() && titleDraft !== task.title) {
      const updated = await patchTask(task.id, { title: titleDraft.trim() });
      setTask(updated);
      onTaskUpdated();
    }
    setEditingTitle(false);
  };

  const handleCwdSave = async () => {
    const newCwd = cwdDraft.trim();
    if (newCwd !== (task.cwd || "")) {
      const updated = await patchTask(task.id, { cwd: newCwd });
      setTask(updated);
      onTaskUpdated();
    }
    setEditingCwd(false);
  };

  const handleNotesSave = async (notes: string) => {
    const updated = await patchTask(task.id, { notes });
    setTask(updated);
  };

  const handleLink = async (resource: any) => {
    const updated = await linkResource(task.id, resource);
    setTask(updated);
    onTaskUpdated();
    setLinkDialogOpen(false);
  };

  const handleUnlink = async (resource: any) => {
    const updated = await unlinkResource(task.id, resource);
    setTask(updated);
    onTaskUpdated();
  };

  const linkedSessions = sessions.filter((s) =>
    task.sessionIds.includes(s.sessionId),
  );

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="p-4 md:p-6 border-b border-[#2a2a4a]">
        <div className="flex flex-wrap items-start gap-3 md:gap-4">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => e.key === "Enter" && handleTitleSave()}
                autoFocus
                className="text-xl md:text-2xl font-bold bg-transparent border-b border-indigo-400 outline-none w-full text-gray-100"
              />
            ) : (
              <h1
                onClick={() => setEditingTitle(true)}
                className="text-xl md:text-2xl font-bold cursor-pointer hover:text-indigo-400 transition-colors"
              >
                {task.title}
              </h1>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => handleStatusChange(s)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                    task.status === s
                      ? STATUS_STYLES[s]
                      : "border-gray-600 text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLinkDialogOpen(true)}
              className="px-3 md:px-4 py-2 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-md text-sm hover:bg-indigo-500/30 transition-colors"
            >
              + Link
            </button>
            {task.status !== "archived" && (
              <button
                onClick={() => handleStatusChange("archived")}
                className="px-3 md:px-4 py-2 text-gray-500 hover:text-yellow-400 text-sm transition-colors"
                title="Archive task"
              >
                📦
              </button>
            )}
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="px-3 md:px-4 py-2 text-gray-500 hover:text-red-400 text-sm transition-colors"
                title="Delete task"
              >
                🗑️
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={async () => {
                    await deleteTask(task.id);
                    onTaskDeleted();
                  }}
                  className="px-3 py-2 bg-red-500/20 text-red-400 border border-red-500/30 rounded-md text-xs hover:bg-red-500/30 transition-colors"
                >
                  Confirm Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-2 text-gray-500 hover:text-gray-300 text-xs transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-6">
        {/* Working Directory */}
        <Section title="📂 Working Directory">
          {editingCwd ? (
            <input
              value={cwdDraft}
              onChange={(e) => setCwdDraft(e.target.value)}
              onBlur={handleCwdSave}
              onKeyDown={(e) => e.key === "Enter" && handleCwdSave()}
              autoFocus
              placeholder="e.g. D:\my-project"
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-indigo-400/50 rounded-md text-sm text-gray-200 outline-none font-mono"
            />
          ) : (
            <button
              onClick={() => setEditingCwd(true)}
              className="w-full text-left px-3 py-2 bg-[#2a2a4a] rounded-md text-sm hover:bg-[#32325a] transition-colors font-mono"
            >
              {task.cwd ? (
                <span className="text-gray-200">{task.cwd}</span>
              ) : (
                <span className="text-gray-500 italic">No working directory set</span>
              )}
            </button>
          )}
        </Section>

        {/* Work Items */}
        <Section title="📋 Work Items" count={task.workItemIds.length}>
          {task.workItemIds.length === 0 ? (
            <Empty>No work items linked</Empty>
          ) : (
            <div className="space-y-1">
              {task.workItemIds.map((id) => (
                <div
                  key={id}
                  className="flex items-center justify-between px-3 py-2 bg-[#2a2a4a] rounded-md"
                >
                  <a
                    href={`https://my-org.visualstudio.com/MyProject/_workitems/edit/${id}`}
                    target="_blank"
                    rel="noopener"
                    className="text-sm text-indigo-400 hover:underline"
                  >
                    Work Item #{id}
                  </a>
                  <button
                    onClick={() =>
                      handleUnlink({ type: "workItem", workItemId: id })
                    }
                    className="text-xs text-gray-500 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Pull Requests */}
        <Section title="🔀 Pull Requests" count={task.pullRequests.length}>
          {task.pullRequests.length === 0 ? (
            <Empty>No PRs linked</Empty>
          ) : (
            <div className="space-y-1">
              {task.pullRequests.map((pr) => (
                <div
                  key={`${pr.repoId}-${pr.prId}`}
                  className="flex items-center justify-between px-3 py-2 bg-[#2a2a4a] rounded-md"
                >
                  <span className="text-sm">
                    {pr.repoName || pr.repoId.slice(0, 8)} — PR #{pr.prId}
                  </span>
                  <button
                    onClick={() =>
                      handleUnlink({
                        type: "pr",
                        repoId: pr.repoId,
                        prId: pr.prId,
                      })
                    }
                    className="text-xs text-gray-500 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Sessions */}
        <Section title="💬 Sessions" count={task.sessionIds.length}>
          <button
            onClick={async () => {
              const sessionId = await createTaskSession(task.id);
              const updated = await fetchTask(task.id);
              setTask(updated);
              onTaskUpdated();
              onOpenSession(sessionId);
            }}
            className="w-full mb-2 px-3 py-2 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-md text-sm hover:bg-indigo-500/30 transition-colors"
          >
            + New Chat for this Task
          </button>
          {linkedSessions.length === 0 ? (
            <Empty>No sessions linked</Empty>
          ) : (
            <div className="space-y-1">
              {linkedSessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="flex items-center justify-between px-3 py-2 bg-[#2a2a4a] rounded-md"
                >
                  <button
                    onClick={() => onOpenSession(s.sessionId)}
                    className="text-sm text-indigo-400 hover:underline text-left truncate flex-1"
                  >
                    {s.summary || s.sessionId.slice(0, 8)}
                  </button>
                  <button
                    onClick={() =>
                      handleUnlink({
                        type: "session",
                        sessionId: s.sessionId,
                      })
                    }
                    className="text-xs text-gray-500 hover:text-red-400 ml-2"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Notes */}
        <Section title="📝 Notes">
          <NotesEditor value={task.notes} onSave={handleNotesSave} />
        </Section>
      </div>

      {/* Link Dialog */}
      {linkDialogOpen && (
        <LinkDialog
          sessions={sessions}
          onLink={handleLink}
          onClose={() => setLinkDialogOpen(false)}
        />
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-400 mb-2">
        {title}
        {count !== undefined && (
          <span className="text-gray-600 ml-1">({count})</span>
        )}
      </h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-gray-600 px-3 py-2">{children}</div>;
}
