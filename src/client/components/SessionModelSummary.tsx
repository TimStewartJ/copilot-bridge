import { RotateCw } from "lucide-react";
import type { ModelInfo, SessionModelState } from "../api";
import { formatSessionModelSummaryLabel } from "../lib/session-model";

export default function SessionModelSummary({
  state,
  models,
  loading,
  error,
  onRetry,
}: {
  state?: SessionModelState;
  models?: readonly ModelInfo[] | null;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  if (error && !state) {
    return (
      <div
        className="shrink-0 flex items-center justify-between gap-3 border-b border-border bg-bg-secondary px-4 py-1.5 text-xs"
        role="status"
        aria-label="Session configuration unavailable"
      >
        <span className="truncate text-text-faint">Session configuration unavailable</span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 text-text-muted hover:text-text-primary"
        >
          <RotateCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    );
  }

  const label = state
    ? formatSessionModelSummaryLabel(state, models)
    : "Loading session configuration...";

  if (state) {
    return (
      <div
        className="shrink-0 flex items-center justify-between gap-3 border-b border-border bg-bg-secondary px-4 py-1.5 text-xs text-text-muted"
        role="group"
        aria-busy={loading}
        aria-label={`Session configuration: ${label}${error ? ". Last refresh failed." : ""}`}
      >
        <span className="block min-w-0 truncate">{label}</span>
        {error && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1 text-text-faint hover:text-text-primary"
            title={error}
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="shrink-0 border-b border-border bg-bg-secondary px-4 py-1.5 text-xs text-text-muted"
      role="status"
      aria-live="polite"
      aria-label={`Session configuration: ${label}`}
    >
      <span className="block truncate">{label}</span>
    </div>
  );
}
