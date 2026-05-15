import { useEffect, useRef } from "react";
import { MessageSquare, Send, X } from "lucide-react";
import { DEFAULT_FEED_ACTION_LABEL } from "../feed-action-helpers";
import { GROUP_COLOR_DOT } from "../group-colors";
import { UI } from "./shared/design-system";

export type FeedActionSubmitMode = "foreground" | "background";

export interface FeedActionTaskPreview {
  id: string;
  title: string;
  group: {
    name: string;
    color: string;
  } | null;
}

interface FeedActionDialogProps {
  cardTitle: string;
  eyebrow?: string;
  actionLabel?: string;
  description?: string;
  taskId: string | null;
  taskPreview: FeedActionTaskPreview | null;
  context?: string | null;
  prompt: string;
  promptLabel?: string;
  promptPlaceholder?: string;
  allowEmptyPrompt?: boolean;
  error: string | null;
  submitting: boolean;
  submitMode: FeedActionSubmitMode | null;
  onPromptChange: (prompt: string) => void;
  onClose: () => void;
  onStart: () => void;
  onStartInBackground: () => void;
}

export default function FeedActionDialog({
  cardTitle,
  eyebrow = "Feed action preview",
  actionLabel,
  description = "Review or edit the prompt before starting a new session.",
  taskId,
  taskPreview,
  context,
  prompt,
  promptLabel = "Prompt to send",
  promptPlaceholder,
  allowEmptyPrompt = false,
  error,
  submitting,
  submitMode,
  onPromptChange,
  onClose,
  onStart,
  onStartInBackground,
}: FeedActionDialogProps) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const promptEmpty = prompt.trim().length === 0;
  const submitDisabled = submitting || (!allowEmptyPrompt && promptEmpty);

  useEffect(() => {
    const promptNode = promptRef.current;
    promptNode?.focus();
    if (promptNode && prompt) {
      promptNode.setSelectionRange?.(prompt.length, prompt.length);
    }
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
              {eyebrow}
            </div>
            <h2 id="feed-action-title" className="mt-1 truncate text-lg font-semibold text-text-primary">
              {actionLabel ?? DEFAULT_FEED_ACTION_LABEL}
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              {description}
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
              <div className="mt-1 text-xs text-text-muted">
                {taskPreview ? (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span>Session will be linked to</span>
                    {taskPreview.group && (
                      <span
                        aria-label={`${taskPreview.group.name} group`}
                        className={`h-2 w-2 shrink-0 rounded-full ${GROUP_COLOR_DOT[taskPreview.group.color] ?? "bg-slate-500"}`}
                        role="img"
                        title={`Group: ${taskPreview.group.name}`}
                      />
                    )}
                    <span className="min-w-0 truncate font-medium text-text-secondary" title={taskPreview.title}>
                      {taskPreview.title}
                    </span>
                    <span aria-hidden="true">.</span>
                  </div>
                ) : (
                  <>Session will be linked to task {taskId}.</>
                )}
              </div>
            )}
          </div>
          {context && (
            <details className="rounded-lg border border-border bg-bg-secondary/60">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-secondary">
                Card context included
              </summary>
              <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs leading-relaxed text-text-muted">
                {context}
              </pre>
            </details>
          )}
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{promptLabel}</span>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              placeholder={promptPlaceholder}
              className={`${context ? "min-h-32" : "min-h-56"} w-full resize-y rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm leading-relaxed text-text-primary outline-none transition-colors focus:border-accent`}
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
            onClick={onStartInBackground}
            disabled={submitDisabled}
            className={`${UI.button.secondary} inline-flex items-center gap-1.5`}
          >
            <Send size={14} />
            {submitMode === "background" ? "Sending..." : "Send in background"}
          </button>
          <button
            type="button"
            onClick={onStart}
            disabled={submitDisabled}
            className={`${UI.button.primary} inline-flex items-center gap-1.5`}
          >
            <MessageSquare size={14} />
            {submitMode === "foreground" ? "Starting..." : "Start session"}
          </button>
        </div>
      </div>
    </div>
  );
}
