import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, FolderOpen, RotateCcw, X } from "lucide-react";
import { patchTask, type Session, type SessionWorkspaceWorktree, type Task, type TaskGitStatus } from "../api";
import {
  useResetSessionWorkspaceMutation,
  useSelectSessionWorkspaceMutation,
  useSessionWorkspaceQuery,
  useSetSessionWorkspacePathMutation,
} from "../hooks/queries/useSessionWorkspace";
import { queryKeys } from "../queryClient";
import {
  areWorkspacePathsEqual,
  buildWorkspaceChoices,
  formatDirtySummary,
  formatGitHead,
  getGitDirtyState,
  getGitStatusHead,
  getGitWorkspaceKind,
  getGitWorktreePath,
} from "../lib/workspace-presentation";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";

const TASK_WORKSPACE_NOT_CONFIGURED = "Task workspace is not configured.";

interface WorkspaceDetailsSheetProps {
  task: Task;
  session?: Session | null;
  taskGitStatus?: TaskGitStatus | null;
  onClose: () => void;
  onTaskUpdated?: () => void;
}

function copyPath(path?: string) {
  if (!path) return;
  void navigator.clipboard.writeText(path);
}

function pathLabel(path?: string) {
  return path ?? "Not configured";
}

function workspaceKindLabel(workspaceKind: "main" | "linked") {
  return workspaceKind === "linked" ? "Linked worktree" : "Main checkout";
}

function WorkspaceChoice({
  worktree,
  selected,
  taskDefaultCwd,
  onSelect,
}: {
  worktree: SessionWorkspaceWorktree;
  selected: boolean;
  taskDefaultCwd?: string;
  onSelect: (cwd: string) => void;
}) {
  const isTaskDefault = areWorkspacePathsEqual(worktree.cwd, taskDefaultCwd);
  return (
    <button
      type="button"
      onClick={() => onSelect(worktree.cwd)}
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
        selected ? "border-accent bg-accent/10" : "border-border bg-bg-secondary hover:bg-bg-hover"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-text-primary" title={worktree.cwd}>
            {worktree.cwd}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
            <span>{formatGitHead(worktree.head)}</span>
            <span>·</span>
            <span>{workspaceKindLabel(worktree.workspaceKind)}</span>
            {worktree.selected && (
              <>
                <span>·</span>
                <span className="text-accent">Current</span>
              </>
            )}
            {isTaskDefault && (
              <>
                <span>·</span>
                <span className="text-text-secondary">Task default</span>
              </>
            )}
          </div>
        </div>
        {selected && <Check size={14} className="mt-0.5 shrink-0 text-accent" />}
      </div>
    </button>
  );
}

function WorkspaceFieldSkeleton() {
  return (
    <LoadingSkeletonRegion isLoading label="Loading session workspace details" className="space-y-2">
      <Skeleton height={14} width="72%" shape="pill" />
      <Skeleton height={12} width="38%" shape="pill" />
    </LoadingSkeletonRegion>
  );
}

function WorktreeListSkeleton() {
  return (
    <LoadingSkeletonRegion isLoading label="Loading available worktrees" className="space-y-2">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="rounded-lg border border-border bg-bg-secondary px-3 py-2">
          <Skeleton height={14} width={index === 0 ? "78%" : "64%"} shape="pill" />
          <div className="mt-2 flex items-center gap-2">
            <Skeleton height={10} width="24%" shape="pill" />
            <Skeleton height={10} width="18%" shape="pill" />
            <Skeleton height={10} width="16%" shape="pill" />
          </div>
        </div>
      ))}
    </LoadingSkeletonRegion>
  );
}

export default function WorkspaceDetailsSheet({
  task,
  session,
  taskGitStatus,
  onClose,
  onTaskUpdated,
}: WorkspaceDetailsSheetProps) {
  const queryClient = useQueryClient();
  const sessionId = session?.sessionId;
  const workspaceQuery = useSessionWorkspaceQuery(sessionId, task.id);
  const sessionWorkspace = sessionId ? workspaceQuery.data : undefined;
  const [draftPath, setDraftPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const selectSessionWorkspace = useSelectSessionWorkspaceMutation(sessionId, task.id);
  const setSessionWorkspacePath = useSetSessionWorkspacePathMutation(sessionId, task.id);
  const resetSessionWorkspace = useResetSessionWorkspaceMutation(sessionId, task.id);

  const effectiveCwd = sessionWorkspace?.effectiveCwd ?? task.cwd;
  const taskDefaultCwd = sessionWorkspace?.taskCwd ?? task.cwd;
  const availableWorktrees = useMemo(() => (
    sessionWorkspace?.availableWorktrees?.length
      ? sessionWorkspace.availableWorktrees
      : buildWorkspaceChoices(taskGitStatus, effectiveCwd)
  ), [effectiveCwd, sessionWorkspace?.availableWorktrees, taskGitStatus]);
  const gitStatus = sessionWorkspace?.gitStatus ?? taskGitStatus;
  const selectedWorktree = availableWorktrees.find((worktree) => areWorkspacePathsEqual(worktree.cwd, draftPath));
  const busy = sessionWorkspace?.busy ?? false;
  const loading = !!sessionId && workspaceQuery.isLoading;
  const actionPending = selectSessionWorkspace.isPending
    || setSessionWorkspacePath.isPending
    || resetSessionWorkspace.isPending;
  const gitHead = gitStatus?.status === "ok" ? getGitStatusHead(gitStatus) : null;
  const gitWorkspaceKind = gitStatus?.status === "ok" ? getGitWorkspaceKind(gitStatus) : null;
  const gitDirtyState = gitStatus?.status === "ok" ? getGitDirtyState(gitStatus) : null;
  const gitWorktreePath = gitStatus?.status === "ok" ? getGitWorktreePath(gitStatus) : undefined;

  useEffect(() => {
    const nextPath = effectiveCwd ?? taskDefaultCwd ?? availableWorktrees[0]?.cwd ?? "";
    setDraftPath(nextPath);
  }, [availableWorktrees, effectiveCwd, taskDefaultCwd]);

  const copyAndFlash = (path?: string) => {
    if (!path) return;
    copyPath(path);
    setCopiedPath(path);
    window.setTimeout(() => {
      setCopiedPath((current) => current === path ? null : current);
    }, 1200);
  };

  const refreshWorkspaceViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGitStatus(task.id) }),
      sessionId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.sessionWorkspace(sessionId, task.id) })
        : Promise.resolve(),
    ]);
    await onTaskUpdated?.();
  };

  const handleUseForSession = async () => {
    if (!sessionId) return;
    const nextPath = draftPath.trim();
    if (!nextPath) {
      setError("Choose or enter a workspace path first.");
      return;
    }
    setError(null);
    try {
      if (sessionWorkspace?.canResetToTask && areWorkspacePathsEqual(nextPath, taskDefaultCwd)) {
        await resetSessionWorkspace.mutateAsync();
      } else if (selectedWorktree) {
        await selectSessionWorkspace.mutateAsync(nextPath);
      } else {
        await setSessionWorkspacePath.mutateAsync(nextPath);
      }
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Failed to update session workspace.");
    }
  };

  const handleSetTaskDefault = async () => {
    const nextPath = draftPath.trim();
    if (!nextPath) {
      setError("Choose or enter a workspace path first.");
      return;
    }
    setError(null);
    try {
      await patchTask(task.id, { cwd: nextPath });
      await refreshWorkspaceViews();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Failed to update task workspace.");
    }
  };

  const handleResetSession = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      await resetSessionWorkspace.mutateAsync();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Failed to reset session workspace.");
    }
  };

  const warningMessage = workspaceQuery.error instanceof Error ? workspaceQuery.error.message : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border border-border bg-bg-primary shadow-2xl md:mb-16 md:mt-16 md:max-h-[80vh] md:max-w-2xl md:rounded-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3 shrink-0">
          <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-text-primary">
            <FolderOpen size={14} className="text-text-muted" />
            <span className="truncate">Workspace details</span>
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted transition-colors hover:text-text-secondary"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {warningMessage && (
            <div className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
              {warningMessage}
            </div>
          )}
          {sessionWorkspace?.warnings?.map((warning) => (
            <div
              key={warning.code}
              className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-secondary"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                <div>
                  <div className="font-medium text-warning">Workspace warning</div>
                  <div className="mt-0.5">{warning.message}</div>
                </div>
              </div>
            </div>
          ))}
          {sessionId && busy && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
              Workspace changes are only allowed while the session is idle.
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-bg-secondary px-3 py-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
                Current session workspace
              </div>
              {sessionId ? (
                loading ? (
                  <WorkspaceFieldSkeleton />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="break-all font-mono text-xs text-text-primary">
                        {pathLabel(sessionWorkspace?.effectiveCwd)}
                      </span>
                      {sessionWorkspace?.overridesTaskWorkspace && (
                        <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                          Overrides task workspace
                        </span>
                      )}
                      {sessionWorkspace?.pathState === "missing" && (
                        <span className="rounded-full bg-error/15 px-1.5 py-0.5 text-[10px] font-medium text-error">
                          Missing
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">
                      {sessionWorkspace?.source === "session_workspace"
                        ? "Pinned for this session"
                        : sessionWorkspace?.source === "task"
                          ? "Using task default"
                          : sessionWorkspace?.source === "workspace_yaml"
                            ? "Using legacy workspace.yaml value"
                            : sessionWorkspace?.source === "default"
                              ? "Using app default workspace"
                              : "Not configured"}
                    </div>
                  </>
                )
              ) : (
                <div className="text-xs text-text-muted">
                  No session selected. Open a task chat to manage a session workspace.
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-bg-secondary px-3 py-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
                Linked task default
              </div>
              <div className="break-all font-mono text-xs text-text-primary">
                {pathLabel(taskDefaultCwd)}
              </div>
              <div className="mt-1 text-[11px] text-text-muted">
                {taskDefaultCwd ? "Used for new task sessions." : TASK_WORKSPACE_NOT_CONFIGURED}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-bg-secondary px-3 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              Git workspace
            </div>
            {gitStatus?.status === "ok" && gitHead && gitWorkspaceKind && gitDirtyState ? (
              <div className="space-y-2 text-xs text-text-secondary">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-text-primary">{formatGitHead(gitHead)}</span>
                  <span className="rounded-full bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-muted">
                    {workspaceKindLabel(gitWorkspaceKind)}
                  </span>
                  {!gitDirtyState.clean && (
                    <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                      Dirty
                    </span>
                  )}
                </div>
                <div>{formatDirtySummary(gitDirtyState)}</div>
                <div>
                  <div className="text-[11px] text-text-faint">Repo root</div>
                  <div className="break-all font-mono text-text-primary">{gitStatus.repoRoot}</div>
                </div>
                <div>
                  <div className="text-[11px] text-text-faint">Worktree path</div>
                  <div className="break-all font-mono text-text-primary">{gitWorktreePath}</div>
                </div>
              </div>
            ) : loading ? (
              <LoadingSkeletonRegion isLoading label="Loading Git workspace details" className="space-y-3">
                <div className="flex items-center gap-2">
                  <Skeleton height={14} width="30%" shape="pill" />
                  <Skeleton height={18} width={82} shape="pill" />
                </div>
                <SkeletonText lines={3} widths={["86%", "68%", "54%"]} />
              </LoadingSkeletonRegion>
            ) : (
              <div className="text-xs text-text-muted">
                {gitStatus?.status === "not_repo"
                  ? "This workspace is not inside a Git repository."
                  : gitStatus?.status === "unavailable"
                    ? gitStatus.error
                    : gitStatus?.status === "not_configured"
                      ? gitStatus.error
                      : "No Git workspace details available."}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-bg-secondary px-3 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              Available worktrees
            </div>
            {loading && availableWorktrees.length === 0 ? (
              <WorktreeListSkeleton />
            ) : availableWorktrees.length > 0 ? (
              <div className="space-y-2">
                {availableWorktrees.map((worktree) => (
                  <WorkspaceChoice
                    key={worktree.cwd}
                    worktree={worktree}
                    selected={areWorkspacePathsEqual(worktree.cwd, draftPath)}
                    taskDefaultCwd={taskDefaultCwd}
                    onSelect={setDraftPath}
                  />
                ))}
              </div>
            ) : (
              <div className="text-xs text-text-muted">
                No sibling worktrees were discovered for this workspace.
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-bg-secondary px-3 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              Selected workspace path
            </div>
            <div className="flex items-center gap-2">
              <input
                value={draftPath}
                onChange={(event) => setDraftPath(event.target.value)}
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-xs font-mono text-text-primary outline-none focus:border-accent"
                placeholder="Enter a workspace path"
              />
              <button
                onClick={() => copyAndFlash(draftPath.trim())}
                disabled={!draftPath.trim()}
                className="rounded-md border border-border px-2 py-2 text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
                title="Copy path"
              >
                {copiedPath && areWorkspacePathsEqual(copiedPath, draftPath) ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <div className="mt-2 text-[11px] text-text-muted">
              Use a discovered worktree above, or enter a custom path for a one-off session override.
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3 shrink-0">
          <button
            onClick={handleUseForSession}
            disabled={!sessionId || loading || busy || actionPending || !draftPath.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Use for this session
          </button>
          <button
            onClick={handleSetTaskDefault}
            disabled={actionPending || !draftPath.trim()}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Set as task default
          </button>
          <button
            onClick={handleResetSession}
            disabled={!sessionId || loading || busy || actionPending || !sessionWorkspace?.canResetToTask}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw size={12} />
            Revert session to task default
          </button>
        </div>
      </div>
    </div>
  );
}
