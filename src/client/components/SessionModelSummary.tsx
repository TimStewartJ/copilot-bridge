import { ChevronDown, RotateCw } from "lucide-react";
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
  onEdit,
  editDisabledReason,
}: {
  /** The chat's name. Left out on a phone, where the bar above the chat already shows it. */
  title?: string;
  state?: SessionModelState;
  models?: readonly ModelInfo[] | null;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  /** Opens the editor for this chat's model, effort and context. Without it the label is plain text. */
  onEdit?: () => void;
  /** Why editing is unavailable right now, such as a working session. Disables the label. */
  editDisabledReason?: string;
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
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          disabled={!!editDisabledReason}
          title={editDisabledReason ?? "Change model, effort, and context for this chat"}
          aria-label={`Change model, effort, and context: ${label}`}
          className={cx(
            "-mx-1.5 inline-flex h-10 min-w-0 items-center gap-1 rounded-md px-1.5 text-left transition-colors md:h-6",
            "hover:bg-bg-hover/60 hover:text-text-primary disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-inherit",
            DS.focus,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-text-faint" aria-hidden="true" />
        </button>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      {error && retry}
    </span>,
  );
}