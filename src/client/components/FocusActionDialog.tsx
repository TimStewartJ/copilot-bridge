import { MessageSquare, Send } from "lucide-react";
import type { ReactNode } from "react";
import { DEFAULT_FOCUS_ACTION_LABEL } from "../focus-item-helpers";
import { GROUP_COLOR_DOT } from "../group-colors";
import FocusDialog from "./FocusDialog";
import { UI } from "./shared/design-system";

export type FocusActionSubmitMode = "foreground" | "background";
export interface FocusActionTaskPreview {
  id: string;
  title: string;
  group: { name: string; color: string } | null;
}
interface FocusActionDialogProps {
  cardTitle: string;
  eyebrow?: string;
  actionLabel?: string;
  description?: string;
  taskId: string | null;
  taskPreview: FocusActionTaskPreview | null;
  context?: string | null;
  prompt: string;
  promptLabel?: string;
  promptPlaceholder?: string;
  allowEmptyPrompt?: boolean;
  error: string | null;
  submitting: boolean;
  submitMode: FocusActionSubmitMode | null;
  onPromptChange: (prompt: string) => void;
  onClose: () => void;
  onStart: () => void;
  onStartInBackground: () => void;
  onReload?: () => void;
  destinationControl?: ReactNode;
  startDisabled?: boolean;
}

export default function FocusActionDialog({
  cardTitle, eyebrow = "Focus session preview", actionLabel, description = "Review or edit the prompt before starting a new session.",
  taskId, taskPreview, context, prompt, promptLabel = "Prompt to send", promptPlaceholder, allowEmptyPrompt = false,
  error, submitting, submitMode, onPromptChange, onClose, onStart, onStartInBackground, onReload,
  destinationControl, startDisabled = false,
}: FocusActionDialogProps) {
  const submitDisabled = submitting || startDisabled || (!allowEmptyPrompt && !prompt.trim());
  return <FocusDialog title={actionLabel ?? DEFAULT_FOCUS_ACTION_LABEL} description={description}
    closeLabel="Close action preview" pending={submitting} onClose={onClose}>
    <div className="space-y-4">
      <p className="text-xs text-text-muted">{eyebrow}</p>
      <div className="rounded-lg border border-border bg-bg-secondary/70 p-3">
        <p className="text-xs font-medium text-text-muted">Focus item</p>
        <p className="mt-1 break-words text-sm font-semibold text-text-primary">{cardTitle}</p>
        {!taskId ? <p className="mt-2 text-xs text-text-muted">Destination: standalone session (Global).</p>
          : <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
            <span>Session will be linked to</span>
            {taskPreview?.group && <span aria-label={`${taskPreview.group.name} group`} role="img"
              title={`Group: ${taskPreview.group.name}`} className={`h-2 w-2 shrink-0 rounded-full ${GROUP_COLOR_DOT[taskPreview.group.color] ?? "bg-slate-500"}`} />}
            <span className="break-words font-medium text-text-secondary">{taskPreview?.title ?? taskId}</span>
          </div>}
      </div>
      {destinationControl}
      {context && <details className="rounded-lg border border-border bg-bg-secondary/60">
        <summary className="min-h-11 cursor-pointer px-3 py-3 text-xs font-medium text-text-secondary">Item context included</summary>
        <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 text-xs text-text-muted">{context}</pre>
      </details>}
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-text-secondary">{promptLabel}</span>
        <textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} placeholder={promptPlaceholder} disabled={submitting}
          className={`${context ? "min-h-32" : "min-h-56"} w-full min-w-0 resize-y rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-accent`} />
      </label>
      {error && <div role="alert" className="rounded-lg border border-error/25 p-3 text-sm text-error">
        {error}{onReload && <button type="button" disabled={submitting} onClick={onReload} className="ml-2 min-h-11 underline">Reload item</button>}
      </div>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <button type="button" onClick={onClose} disabled={submitting} className={`${UI.button.secondary} min-h-11`}>Cancel</button>
        <button type="button" onClick={onStartInBackground} disabled={submitDisabled} className={`${UI.button.secondary} inline-flex min-h-11 items-center gap-1.5`}>
          <Send size={14} />{submitMode === "background" ? "Sending..." : "Send in background"}
        </button>
        <button type="button" onClick={onStart} disabled={submitDisabled} className={`${UI.button.primary} inline-flex min-h-11 items-center gap-1.5`}>
          <MessageSquare size={14} />{submitMode === "foreground" ? "Starting..." : "Start session"}
        </button>
      </div>
    </div>
  </FocusDialog>;
}
