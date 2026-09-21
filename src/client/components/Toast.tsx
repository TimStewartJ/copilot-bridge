import { AlertCircle, ArrowRight, CheckCircle2, Info, Loader2, Undo2, X } from "lucide-react";
import { DS, cx } from "../design/tokens";

export type ToastTone = "success" | "info" | "error";

export interface ToastAction {
  label: string;
  /** Label shown while `onAction` is in flight. */
  pendingLabel?: string;
  icon?: "undo" | "open";
  onAction: () => void | Promise<void>;
}

export interface ToastData {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  footnote?: string;
  action?: ToastAction;
  loading?: boolean;
  /** Auto-dismiss delay. Omit to use the provider default; 0 disables auto-dismiss. */
  durationMs?: number;
}

const TONE_STYLES: Record<ToastTone, { border: string; icon: string }> = {
  success: { border: "border-success/20", icon: "text-success" },
  info: { border: "border-info/20", icon: "text-info" },
  error: { border: "border-error/20", icon: "text-error" },
};

function ToneIcon({ tone, loading }: { tone: ToastTone; loading?: boolean }) {
  const className = `mt-0.5 shrink-0 ${TONE_STYLES[tone].icon}`;
  if (loading) return <Loader2 size={18} className={cx(className, "animate-spin")} />;
  if (tone === "error") return <AlertCircle size={18} className={className} />;
  if (tone === "info") return <Info size={18} className={className} />;
  return <CheckCircle2 size={18} className={className} />;
}

interface ToastProps {
  toast: ToastData;
  actionPending?: boolean;
  onAction: () => void;
  onDismiss: () => void;
}

export default function Toast({ toast, actionPending = false, onAction, onDismiss }: ToastProps) {
  const { action } = toast;
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      className={cx(DS.surface.floating, "pointer-events-auto w-full max-w-md backdrop-blur", TONE_STYLES[toast.tone].border)}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <ToneIcon tone={toast.tone} loading={toast.loading} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">{toast.title}</div>
          {toast.description && (
            <div className="mt-1 text-xs text-text-muted">{toast.description}</div>
          )}
          {toast.footnote && (
            <div className="mt-1 text-xs text-text-faint">{toast.footnote}</div>
          )}
          <div className="mt-3 flex items-center gap-3">
            {action && (
              <button
                type="button"
                onClick={onAction}
                disabled={actionPending}
                className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "gap-1 text-accent hover:text-accent-hover disabled:text-text-faint")}
              >
                {action.icon === "open" ? <ArrowRight size={12} /> : <Undo2 size={12} />}
                {actionPending ? action.pendingLabel ?? action.label : action.label}
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "text-text-faint")}
            >
              Dismiss
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost, "text-text-faint")}
          aria-label={`Dismiss notification: ${toast.title}`}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
