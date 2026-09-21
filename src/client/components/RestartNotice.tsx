import { Check, RefreshCw } from "lucide-react";
import type { RestartNotice as RestartNoticeModel } from "../hooks/queries/useRestartStatus";

interface Props {
  notice: RestartNoticeModel;
  /** Titles of the sessions the restart is waiting for, when known. */
  waitingSessionTitles?: string[];
  /** The page reload after a restart is held back by work it would destroy. */
  reloadHeld?: boolean;
  restartingNow?: boolean;
  error?: string | null;
  onRestartNow?: () => void;
  onReload?: () => void;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function describeWaiting(sessions: number, jobs: number, operations = 0): string {
  const parts = [sessions > 0 ? count(sessions, "session") : "", jobs > 0 ? count(jobs, "job") : "",
    operations > 0 ? count(operations, "background task") : ""].filter(Boolean);
  if (parts.length === 0) return "when Bridge is idle";
  return `after ${parts.join(" and ")} ${sessions + jobs + operations === 1 ? "finishes" : "finish"}`;
}

/**
 * One quiet line. A pending restart blocks nothing and may stay pending for hours, so it is a note
 * about the background rather than an alert: no colour, no layout beyond a single row.
 */
export default function RestartNotice({
  notice,
  waitingSessionTitles = [],
  reloadHeld = false,
  restartingNow = false,
  error = null,
  onRestartNow,
  onReload,
}: Props) {
  const waiting = notice.kind === "waiting";
  const text = notice.kind === "restarted"
    ? reloadHeld ? "Bridge restarted \u00b7 reloads once your unsent work is safe" : "Bridge restarted \u00b7 reloading\u2026"
    : notice.kind === "restarting"
      ? "Bridge is restarting\u2026"
      : `Restart pending \u00b7 ${describeWaiting(notice.sessions, notice.jobs, notice.operations)}`;
  const action = notice.kind === "restarted"
    ? reloadHeld && onReload ? { label: "Reload now", run: onReload } : null
    : waiting && notice.sessions + notice.jobs + (notice.operations ?? 0) > 0 && onRestartNow
      ? { label: restartingNow ? "Restarting\u2026" : "Restart now", run: onRestartNow }
      : null;

  return (
    <div
      role="status"
      title={waiting && waitingSessionTitles.length > 0 ? `Waiting for: ${waitingSessionTitles.join(", ")}` : undefined}
      className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-secondary px-4 py-1 text-xs text-text-muted"
    >
      {notice.kind === "restarted"
        ? <Check size={12} className="shrink-0" />
        : <RefreshCw size={12} className={`shrink-0 ${waiting ? "" : "animate-spin"}`} />}
      <span className="min-w-0 truncate">{error ?? text}</span>
      {action && (
        <button
          type="button"
          onClick={action.run}
          disabled={restartingNow}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-60"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
