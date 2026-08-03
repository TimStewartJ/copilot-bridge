import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, Loader2, Trash2, X } from "lucide-react";
import type { SessionDisposition, Task, TaskDeletionPreview } from "../api";

/**
 * Above this many sessions a delete is warned about rather than blocked: each
 * session costs a backend round-trip plus a recursive directory removal, so the
 * run can outlast the HTTP response. The work is resumable, so the warning
 * explains the wait instead of forbidding it.
 */
export const SLOW_SESSION_DELETE_THRESHOLD = 250;

interface ConfirmTaskDeleteDialogProps {
  task: Task;
  preview?: TaskDeletionPreview;
  previewError?: string;
  /** Live session count while a delete runs, polled from the preview endpoint. */
  progressRemaining?: number;
  busy?: SessionDisposition;
  actionError?: string;
  onConfirm: (disposition: SessionDisposition) => void;
  onClose: () => void;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export default function ConfirmTaskDeleteDialog({
  task,
  preview,
  previewError,
  progressRemaining,
  busy,
  actionError,
  onConfirm,
  onClose,
}: ConfirmTaskDeleteDialogProps) {
  const archiveRef = useRef<HTMLButtonElement>(null);
  const isBusy = busy !== undefined;

  useEffect(() => {
    archiveRef.current?.focus();
  }, [preview]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isBusy) onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose, isBusy]);

  const sessionCount = preview?.sessionCount ?? 0;
  const busyCount = preview?.busySessionIds.length ?? 0;
  const deleteBlocked = busyCount > 0;
  const slowDelete = sessionCount > SLOW_SESSION_DELETE_THRESHOLD;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isBusy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Delete task"
    >
      <div className="bg-bg-secondary border border-border rounded-xl shadow-2xl w-full max-w-[440px] mx-4 flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-medium text-sm">Delete task</h3>
          <button
            onClick={onClose}
            disabled={isBusy}
            aria-label="Close"
            className="text-text-muted hover:text-text-secondary disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3 text-sm">
          <p className="text-text-secondary">
            Delete <span className="font-medium text-text-primary">{task.title}</span>?
          </p>

          {previewError ? (
            <p className="text-error text-xs">{previewError}</p>
          ) : !preview ? (
            <p className="text-text-faint text-xs flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Checking linked sessions…
            </p>
          ) : sessionCount === 0 ? (
            <p className="text-text-faint text-xs">
              No sessions are linked to this task.
              {preview.scheduleCount > 0
                && ` ${plural(preview.scheduleCount, "schedule")} will also be deleted.`}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-text-secondary">
                This task has{" "}
                <span className="font-medium text-text-primary">
                  {plural(sessionCount, "linked session")}
                </span>
                {preview.archivedCount > 0 && (
                  <span className="text-text-faint"> ({preview.archivedCount} already archived)</span>
                )}
                . Choose what happens to them.
              </p>
              {preview.scheduleCount > 0 && (
                <p className="text-text-faint text-xs">
                  {plural(preview.scheduleCount, "schedule")} will also be deleted.
                </p>
              )}
              {preview.sharedSessionCount > 0 && (
                <p className="text-text-faint text-xs">
                  {plural(preview.sharedSessionCount, "session")} also belong to another task and
                  will be unlinked rather than deleted.
                </p>
              )}
            </div>
          )}

          {deleteBlocked && (
            <p className="text-warning text-xs flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                {plural(busyCount, "session")} still running. Sessions can be archived now, but
                deleting has to wait until they finish.
              </span>
            </p>
          )}

          {slowDelete && !deleteBlocked && (
            <p className="text-text-faint text-xs flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Deleting this many sessions can take several minutes. You can close this and retry
                later — it picks up where it left off.
              </span>
            </p>
          )}

          {progressRemaining !== undefined && (
            <p className="text-text-faint text-xs" role="status">
              Deleting sessions… {Math.max(sessionCount - progressRemaining, 0)} of {sessionCount} done.
            </p>
          )}

          {actionError && <p className="text-error text-xs">{actionError}</p>}
        </div>

        <div className="flex flex-col gap-2 p-4 pt-0">
          <button
            ref={archiveRef}
            onClick={() => onConfirm("archive")}
            disabled={isBusy || !preview}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm bg-bg-primary border border-border hover:bg-bg-hover disabled:opacity-50 transition-colors"
          >
            {busy === "archive"
              ? <Loader2 size={14} className="animate-spin" />
              : <Archive size={14} />}
            {sessionCount === 0 ? "Delete task" : "Archive sessions & delete task"}
          </button>

          {sessionCount > 0 && (
            <button
              onClick={() => onConfirm("delete")}
              disabled={isBusy || !preview || deleteBlocked}
              title={deleteBlocked ? "Some linked sessions are still running" : undefined}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm bg-error/10 text-error border border-error/30 hover:bg-error/20 disabled:opacity-40 transition-colors"
            >
              {busy === "delete"
                ? <Loader2 size={14} className="animate-spin" />
                : <Trash2 size={14} />}
              Delete sessions & delete task
            </button>
          )}

          <button
            onClick={onClose}
            disabled={isBusy}
            className="w-full px-3 py-2 rounded-md text-sm text-text-muted hover:text-text-secondary disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Polls the preview endpoint so a long delete shows progress instead of a
 * spinner. A big delete can outlive its HTTP response, so this keeps tracking
 * the server-side work after the request itself has given up; `taskGone`
 * reports the completion the lost response would have carried.
 */
export function useTaskDeletionProgress(
  taskId: string | undefined,
  active: boolean,
  fetchPreview: (id: string) => Promise<TaskDeletionPreview>,
  intervalMs = 1500,
): { remaining?: number; taskGone: boolean } {
  const [state, setState] = useState<{ remaining?: number; taskGone: boolean }>({ taskGone: false });

  useEffect(() => {
    if (!active || !taskId) {
      setState({ taskGone: false });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchPreview(taskId);
        if (!cancelled) setState({ remaining: next.sessionCount, taskGone: false });
      } catch (err) {
        // A 404 means the task is gone, i.e. the delete finished. Any other
        // failure is transient — keep polling rather than declare success.
        const status = (err as { status?: number } | null)?.status;
        if (!cancelled && status === 404) setState({ remaining: 0, taskGone: true });
      }
    };
    const timer = setInterval(() => { void poll(); }, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, taskId, fetchPreview, intervalMs]);

  return state;
}
