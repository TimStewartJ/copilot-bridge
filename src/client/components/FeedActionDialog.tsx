import { useEffect, useRef } from "react";
import { MessageSquare, X } from "lucide-react";
import { DEFAULT_FEED_ACTION_LABEL } from "../feed-action-helpers";
import { UI } from "./shared/design-system";

interface FeedActionDialogProps {
  cardTitle: string;
  actionLabel?: string;
  taskId: string | null;
  prompt: string;
  error: string | null;
  submitting: boolean;
  onPromptChange: (prompt: string) => void;
  onClose: () => void;
  onStart: () => void;
}

export default function FeedActionDialog({
  cardTitle,
  actionLabel,
  taskId,
  prompt,
  error,
  submitting,
  onPromptChange,
  onClose,
  onStart,
}: FeedActionDialogProps) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    promptRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feed-action-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-primary shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
              <MessageSquare size={14} />
              Feed action preview
            </div>
            <h2 id="feed-action-title" className="mt-1 truncate text-lg font-semibold text-text-primary">
              {actionLabel ?? DEFAULT_FEED_ACTION_LABEL}
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              Review or edit the prompt before starting a new session.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
            aria-label="Close action preview"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="rounded-lg border border-border bg-bg-secondary/70 p-3">
            <div className="text-xs font-medium text-text-muted">Card</div>
            <div className="mt-1 text-sm font-semibold text-text-primary">{cardTitle}</div>
            {taskId && (
              <div className="mt-1 text-xs text-text-muted">Session will be linked to task {taskId}.</div>
            )}
          </div>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Prompt to send</span>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              className="min-h-56 w-full resize-y rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm leading-relaxed text-text-primary outline-none transition-colors focus:border-accent"
              disabled={submitting}
            />
          </label>
          {error && (
            <div className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-sm text-error">
              {error}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className={UI.button.secondary}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onStart}
            disabled={submitting || prompt.trim().length === 0}
            className={`${UI.button.primary} inline-flex items-center gap-1.5`}
          >
            <MessageSquare size={14} />
            {submitting ? "Starting..." : "Start session"}
          </button>
        </div>
      </div>
    </div>
  );
}
