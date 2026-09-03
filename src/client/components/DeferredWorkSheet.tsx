import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import type {
  DeferredWorkItem,
  DeferredWorkRun,
  DeferredWorkStatus,
  Session,
} from "../api";
import {
  useCancelSessionDeferMutation,
  useReactivateSessionDeferMutation,
  useSessionDefersQuery,
} from "../hooks/queries/useSessionDefers";
import { timeAgo } from "../time";
import EmptyState from "./shared/EmptyState";
import { useModalDialog } from "./shared/useModalDialog";

interface DeferredWorkSheetProps {
  session: Pick<Session, "sessionId" | "summary">;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}

const ACTIVE_STATUSES = new Set<DeferredWorkStatus>(["active", "pending", "running"]);

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function formatInterval(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function statusTone(status: DeferredWorkStatus): string {
  if (status === "active" || status === "pending") return "border-accent/25 bg-accent/10 text-accent";
  if (status === "running") return "border-info/25 bg-info/10 text-info";
  if (status === "completed") return "border-success/25 bg-success/10 text-success";
  if (status === "failed") return "border-error/25 bg-error/10 text-error";
  return "border-border bg-bg-secondary text-text-muted";
}

function statusLabel(status: DeferredWorkStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function runLabel(run: DeferredWorkRun): string {
  switch (run.action) {
    case "continue": return "Continued";
    case "finish": return "Finished silently";
    case "return": return "Returned to parent";
    case "expired": return "Expired";
    case "error": return "Failed";
  }
}

function RunIcon({ run }: { run: DeferredWorkRun }) {
  if (run.action === "error") return <XCircle size={14} className="text-error" />;
  if (run.action === "continue") return <Clock size={14} className="text-accent" />;
  return <CheckCircle2 size={14} className="text-success" />;
}

function DeferCard({
  item,
  busy,
  onCancel,
  onReactivate,
}: {
  item: DeferredWorkItem;
  busy: boolean;
  onCancel: (deferId: string) => void;
  onReactivate: (deferId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">
            {item.name || (item.kind === "interval" ? "Recurring defer" : "One-time defer")}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
            <span className={`rounded-full border px-1.5 py-0.5 font-medium ${statusTone(item.status)}`}>
              {statusLabel(item.status)}
            </span>
            <span>{item.kind === "interval" ? "Recurring" : "One time"}</span>
            {ACTIVE_STATUSES.has(item.status) && (
              <span title={new Date(item.nextRunAt).toLocaleString()}>
                Next {timeAgo(item.nextRunAt)}
              </span>
            )}
          </div>
        </div>
        {item.canCancel && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancel(item.deferId)}
            className="shrink-0 rounded-md border border-error/25 px-2 py-1 text-xs text-error hover:bg-error/10 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        {item.canReactivate && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onReactivate(item.deferId)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            <RotateCcw size={11} />
            Reactivate
          </button>
        )}
      </div>

      <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
        {item.prompt}
      </p>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px] text-text-muted">
        {item.intervalSeconds !== undefined && <span>Every {formatInterval(item.intervalSeconds)}</span>}
        {item.runCount !== undefined && (
          <span>
            {item.runCount} run{item.runCount === 1 ? "" : "s"}
            {item.maxRuns !== undefined ? ` of ${item.maxRuns}` : ""}
          </span>
        )}
        {item.attempts > 0 && <span>{item.attempts} current attempt{item.attempts === 1 ? "" : "s"}</span>}
        {item.expiresAt && <span title={new Date(item.expiresAt).toLocaleString()}>Expires {timeAgo(item.expiresAt)}</span>}
      </div>

      {item.lastError && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-error/20 bg-error/10 px-2 py-1.5 text-xs text-error">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{item.lastError}</span>
        </div>
      )}
    </div>
  );
}

export default function DeferredWorkSheet({
  session,
  onClose,
  restoreFocusTo,
}: DeferredWorkSheetProps) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const query = useSessionDefersQuery(session.sessionId);
  const cancelMutation = useCancelSessionDeferMutation(session.sessionId);
  const reactivateMutation = useReactivateSessionDeferMutation(session.sessionId);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = cancelMutation.isPending || reactivateMutation.isPending;
  const defers = query.data?.defers ?? [];
  const active = defers.filter((item) => ACTIVE_STATUSES.has(item.status));
  const inactive = defers.filter((item) => !ACTIVE_STATUSES.has(item.status));
  const runs = query.data?.recentRuns ?? [];
  const deferLabels = new Map(
    defers.map((item) => [
      item.deferId,
      item.name || (item.kind === "interval" ? "Recurring defer" : "One-time defer"),
    ]),
  );

  useEffect(() => {
    restoreFocusRef.current = restoreFocusTo
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeButtonRef.current?.focus();
    return () => {
      if (restoreFocusRef.current?.isConnected !== false) {
        restoreFocusRef.current?.focus();
      }
    };
  }, [restoreFocusTo]);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const mutate = async (action: "cancel" | "reactivate", deferId: string) => {
    setActionError(null);
    try {
      if (action === "cancel") {
        await cancelMutation.mutateAsync(deferId);
      } else {
        await reactivateMutation.mutateAsync(deferId);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Deferred work update failed.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        {...dialogProps}
        ref={dialogRef}
        onKeyDown={handleDialogKeyDown}
        className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border border-border bg-bg-primary shadow-2xl md:mb-16 md:mt-16 md:max-h-[80vh] md:max-w-2xl md:rounded-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-text-primary">Deferred Work</h2>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              {session.summary || session.sessionId.slice(0, 8)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => { void query.refetch(); }}
              disabled={query.isFetching}
              className="rounded-md p-2 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              title="Refresh deferred work"
            >
              <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className="rounded-md p-2 text-text-muted hover:bg-bg-hover hover:text-text-primary"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {(actionError || query.error) && (
            <div className="rounded-md border border-error/25 bg-error/10 px-3 py-2 text-xs text-error" role="alert">
              {actionError || (query.error instanceof Error ? query.error.message : "Failed to load deferred work.")}
            </div>
          )}

          {query.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading deferred work
            </div>
          ) : defers.length === 0 && runs.length === 0 ? (
            <EmptyState
              message="No deferred work"
              sub="Defers created by this session will appear here."
            />
          ) : (
            <>
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Active</h3>
                  <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-faint">{active.length}</span>
                </div>
                {active.length > 0 ? (
                  <div className="space-y-2">
                    {active.map((item) => (
                      <DeferCard
                        key={item.deferId}
                        item={item}
                        busy={busy}
                        onCancel={(deferId) => { void mutate("cancel", deferId); }}
                        onReactivate={(deferId) => { void mutate("reactivate", deferId); }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-xs text-text-muted">
                    No active defers.
                  </div>
                )}
              </section>

              {inactive.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Recent defers</h3>
                    <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-faint">{inactive.length}</span>
                  </div>
                  <div className="space-y-2">
                    {inactive.map((item) => (
                      <DeferCard
                        key={item.deferId}
                        item={item}
                        busy={busy}
                        onCancel={(deferId) => { void mutate("cancel", deferId); }}
                        onReactivate={(deferId) => { void mutate("reactivate", deferId); }}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Recent checks</h3>
                  <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-faint">{runs.length}</span>
                </div>
                {runs.length > 0 ? (
                  <div className="divide-y divide-border rounded-lg border border-border bg-bg-elevated">
                    {runs.map((run) => (
                      <div key={run.id} className="flex items-start gap-2.5 px-3 py-2.5">
                        <RunIcon run={run} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium text-text-primary">
                              {deferLabels.get(run.deferId) ?? run.deferId} · {runLabel(run)}
                            </span>
                            <span className="text-[10px] text-text-faint" title={new Date(run.completedAt).toLocaleString()}>
                              {timeAgo(run.completedAt)}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-text-muted">
                            {run.runCount !== undefined && <span>Run {run.runCount}</span>}
                            {run.model && <span>{run.model}</span>}
                            {run.reasoningEffort && <span>{run.reasoningEffort} effort</span>}
                            {run.contextTier === "long_context" && <span>Long context</span>}
                            <span>{formatDuration(run.durationMs)}</span>
                          </div>
                          {run.error && <p className="mt-1 break-words text-xs text-error">{run.error}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-xs text-text-muted">
                    No worker checks recorded in the last seven days.
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
