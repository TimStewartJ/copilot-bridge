import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import type { ModelInfo, SessionModelState } from "../api";
import { formatSessionModelSummaryLabel } from "../lib/session-model";
import { DS, cx } from "../design/tokens";

/**
 * What a chat is and what it runs on, as a few quiet words for the chat header. It draws no bar of
 * its own: the header it sits in owns the line.
 */
export default function SessionModelSummary({
  title,
  state,
  models,
  loading,
  error,
  onRetry,
}: {
  /** The chat's name. Left out on a phone, where the bar above the chat already shows it. */
  title?: string;
  state?: SessionModelState;
  models?: readonly ModelInfo[] | null;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const name = title
    ? <span className="hidden min-w-0 truncate font-medium text-text-secondary md:block" title={title}>{title}</span>
    : null;
  const retry = (
    <button
      type="button"
      onClick={onRetry}
      className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
      title={error}
    >
      <RotateCw className="h-3 w-3" aria-hidden="true" />
      Retry
    </button>
  );
  const line = (configuration: ReactNode) => (
    <>
      {name}
      {configuration}
    </>
  );

  if (error && !state) {
    return line(
      <span className="inline-flex min-w-0 items-center gap-2" role="status" aria-label="Session configuration unavailable">
        <span className="truncate text-text-faint">Session configuration unavailable</span>
        {retry}
      </span>,
    );
  }

  const label = state
    ? formatSessionModelSummaryLabel(state, models)
    : "Loading session configuration...";

  if (!state) {
    return line(
      <span className="block min-w-0 truncate text-text-faint" role="status" aria-live="polite" aria-label={`Session configuration: ${label}`}>
        {label}
      </span>,
    );
  }

  return line(
    <span
      className="inline-flex min-w-0 items-center gap-2 md:shrink-0"
      role="group"
      aria-busy={loading}
      aria-label={`Session configuration: ${label}${error ? ". Last refresh failed." : ""}`}
    >
      <span className="min-w-0 truncate">{label}</span>
      {error && retry}
    </span>,
  );
}