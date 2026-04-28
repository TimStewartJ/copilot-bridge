import { CheckCircle2, Undo2, X } from "lucide-react";

export interface TaskCompletionToastData {
  taskId: string;
  taskTitle: string;
  summary: string;
  doneWhenCopy?: string;
}

interface Props {
  feedback: TaskCompletionToastData;
  undoing?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

export default function TaskCompletionToast({ feedback, undoing = false, onUndo, onDismiss }: Props) {
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-20 z-50 flex justify-center md:inset-x-auto md:right-6 md:bottom-6">
      <div
        aria-live="polite"
        className="pointer-events-auto w-full max-w-md rounded-xl border border-success/20 bg-bg-elevated/95 shadow-lg backdrop-blur"
      >
        <div className="flex items-start gap-3 px-4 py-3">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-primary">{feedback.taskTitle} completed</div>
            <div className="mt-1 text-xs text-text-muted">{feedback.summary}</div>
            {feedback.doneWhenCopy && (
              <div className="mt-1 text-xs text-text-faint">{feedback.doneWhenCopy}</div>
            )}
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={onUndo}
                disabled={undoing}
                className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-colors hover:text-accent-hover disabled:cursor-wait disabled:text-text-faint"
              >
                <Undo2 size={12} />
                {undoing ? "Reopening…" : "Reopen task"}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs text-text-faint transition-colors hover:text-text-muted"
              >
                Dismiss
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded p-1 text-text-faint transition-colors hover:bg-bg-hover hover:text-text-muted"
            aria-label="Dismiss task completion message"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
