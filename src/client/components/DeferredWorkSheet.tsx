import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Braces,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import type {
  DeferredWorkItem,
  DeferredWorkDelivery,
  DeferredWorkRun,
  DeferredWorkStatus,
  Session,
} from "../api";
import { DEFER_CHECKPOINT_MAX_BYTES, type DeferCheckpoint } from "../../shared/defer-checkpoint.js";
import {
  useCancelSessionDeferMutation,
  useReactivateSessionDeferMutation,
  useSessionDefersQuery,
} from "../hooks/queries/useSessionDefers";
import { writeClipboardText } from "../lib/clipboard";
import { timeAgo } from "../time";
import JsonTree from "./shared/JsonTree";
import { useModalDialog } from "./shared/useModalDialog";
import { DS, cx, type DsTone } from "../design/tokens";
import { Badge, Button, EmptyHint, Notice, Section } from "../design/primitives";
import { formatUsageCredits as formatCredits, formatUsageNumber as formatNumber } from "../lib/usage-presentation";

interface DeferredWorkSheetProps {
  session: Pick<Session, "sessionId" | "summary">;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}

const ACTIVE_STATUSES = new Set<DeferredWorkStatus>(["active", "pending", "running"]);
const CHECKPOINT_NEAR_LIMIT_RATIO = 0.8;
const COPY_FEEDBACK_MS = 2_000;

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

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const kilobytes = bytes / 1_024;
  return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
}

function statusTone(status: DeferredWorkStatus): DsTone {
  if (status === "running") return "info";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

function statusLabel(status: DeferredWorkStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function runLabel(run: DeferredWorkRun): string {
  switch (run.action) {
    case "continue": return "Continued";
    case "notify": return "Notified parent and continued";
    case "finish": return "Finished silently";
    case "return": return "Returned to parent";
    case "expired": return "Expired";
    case "error": return "Failed";
  }
}

function RunIcon({ run }: { run: DeferredWorkRun }) {
  if (run.action === "error") return <XCircle size={14} className="text-error" />;
  if (run.action === "continue" || run.action === "notify") {
    return <Clock size={14} className="text-accent" />;
  }
  return <CheckCircle2 size={14} className="text-success" />;
}

function DeliveryIcon({ delivery }: { delivery: DeferredWorkDelivery }) {
  if (delivery.status === "failed") return <XCircle size={14} className="text-error" />;
  if (delivery.status === "pending" || delivery.status === "running") {
    return <Clock size={14} className="text-accent" />;
  }
  return <CheckCircle2 size={14} className="text-success" />;
}

type CopyState = "idle" | "copied" | "failed";

const COPY_LABELS: Record<CopyState, string> = {
  idle: "Copy checkpoint JSON",
  copied: "Copied",
  failed: "Copy failed",
};

function CopyCheckpointButton({ checkpoint }: { checkpoint: DeferCheckpoint }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);

  useEffect(() => () => {
    requestRef.current += 1;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, []);

  const copy = () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
    setCopyState("idle");

    const settle = (next: CopyState) => {
      if (requestRef.current !== requestId) return;
      setCopyState(next);
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        if (requestRef.current === requestId) setCopyState("idle");
      }, COPY_FEEDBACK_MS);
    };

    void writeClipboardText(JSON.stringify(checkpoint, null, 2)).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={COPY_LABELS[copyState]}
      title={COPY_LABELS[copyState]}
      className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost)}
    >
      {copyState === "copied" && <Check size={13} className="text-copy-success" />}
      {copyState === "failed" && <AlertTriangle size={13} className="text-error" />}
      {copyState === "idle" && <Copy size={13} />}
    </button>
  );
}

function DeferCheckpointPreview({ item }: { item: DeferredWorkItem }) {
  const isActive = ACTIVE_STATUSES.has(item.status);
  const [open, setOpen] = useState(isActive);
  const { checkpoint } = item;
  const summary = useMemo(() => {
    if (!checkpoint) return null;
    return {
      keyCount: Object.keys(checkpoint).length,
      bytes: new TextEncoder().encode(JSON.stringify(checkpoint)).length,
    };
  }, [checkpoint]);
  const label = isActive ? "Checkpoint" : "Last checkpoint";
  const nearLimit = !!summary
    && summary.bytes >= DEFER_CHECKPOINT_MAX_BYTES * CHECKPOINT_NEAR_LIMIT_RATIO;

  return (
    <div className={cx(DS.surface.detail, "mt-3 overflow-hidden")}>
      <div className="flex items-center justify-between gap-2 py-1.5 pl-2.5 pr-1.5">
        <div
          className="flex min-w-0 items-center gap-2 text-[11px]"
          title="Private JSON state the recurring worker passes to its next check. It is never sent to this session."
        >
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent-surface text-accent">
            <Braces size={12} aria-hidden="true" />
          </span>
          <span className="shrink-0 text-xs font-semibold text-text-primary">{label}</span>
          {summary ? (
            <span className={`truncate ${nearLimit ? "text-warning" : "text-text-muted"}`}>
              {summary.keyCount} key{summary.keyCount === 1 ? "" : "s"} · {formatBytes(summary.bytes)} of{" "}
              {formatBytes(DEFER_CHECKPOINT_MAX_BYTES)}
            </span>
          ) : (
            <span className="truncate text-text-faint">{isActive ? "None saved yet" : "None saved"}</span>
          )}
        </div>
        {checkpoint && (
          <div className="flex shrink-0 items-center gap-0.5">
            <CopyCheckpointButton checkpoint={checkpoint} />
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
            >
              {open ? "Hide" : "Show"}
            </button>
          </div>
        )}
      </div>
      {checkpoint && open && (
        <div
          role="region"
          aria-label={`${label} JSON`}
          tabIndex={0}
          className="max-h-96 overflow-auto border-t border-border-subtle px-1 py-1.5"
        >
          <JsonTree value={checkpoint} />
        </div>
      )}
    </div>
  );
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
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">
            {item.name || (item.kind === "interval" ? "Recurring defer" : "One-time defer")}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
            <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
            <span>{item.kind === "interval" ? "Recurring" : "One time"}</span>
            {ACTIVE_STATUSES.has(item.status) && (
              <span title={new Date(item.nextRunAt).toLocaleString()}>
                Next {timeAgo(item.nextRunAt)}
              </span>
            )}
          </div>
        </div>
        {item.canCancel && (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => onCancel(item.deferId)}>Cancel</Button>
        )}
        {item.canReactivate && (
          <Button size="sm" disabled={busy} onClick={() => onReactivate(item.deferId)} icon={<RotateCcw size={11} />}>
            {item.failedDelivery ? "Retry delivery" : "Reactivate"}
          </Button>
        )}
      </div>

      {item.kind === "interval" && <DeferCheckpointPreview item={item} />}

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
        <Notice tone="danger" icon={<AlertTriangle size={12} />} className="mt-2">{item.lastError}</Notice>
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
  const deliveries = query.data?.recentDeliveries ?? [];
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
        className={DS.surface.sheet}
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
              className={cx(DS.button.base, DS.button.icon.md, DS.button.variant.ghost)}
              aria-label="Refresh deferred work"
              title="Refresh deferred work"
            >
              <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className={cx(DS.button.base, DS.button.icon.md, DS.button.variant.ghost)}
              aria-label="Close deferred work"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {(actionError || query.error) && (
            <Notice tone="danger" icon={<AlertTriangle size={14} />}>
              {actionError || (query.error instanceof Error ? query.error.message : "Failed to load deferred work.")}
            </Notice>
          )}

          {query.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading deferred work
            </div>
          ) : defers.length === 0 && runs.length === 0 && deliveries.length === 0 ? (
            <EmptyHint>No deferred work. Defers created by this session will appear here.</EmptyHint>
          ) : (
            <>
              <Section label="Active" count={active.length}>
                {active.length > 0 ? (
                  <div className={DS.surface.divided}>
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
                  <EmptyHint>No active defers.</EmptyHint>
                )}
              </Section>

              {inactive.length > 0 && (
                <Section label="Recent defers" count={inactive.length}>
                  <div className={DS.surface.divided}>
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
                </Section>
              )}

              <Section label="Recent checks" count={runs.length}>
                <p className={cx(DS.usage.prose, "mb-2")}>
                  Tokens and SDK-reported metered AI credits are captured at worker shutdown. Estimates use the local Copilot price card.
                </p>
                {runs.length > 0 ? (
                  <div className={DS.surface.divided}>
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
                          <div className={cx("mt-0.5 flex flex-wrap gap-x-2", DS.usage.meta)}>
                            {run.runCount !== undefined && <span>Run {run.runCount}</span>}
                            {run.model && <span>{run.model}</span>}
                            {run.reasoningEffort && <span>{run.reasoningEffort} effort</span>}
                            {run.contextTier === "long_context" && <span>Long context</span>}
                            <span>{formatDuration(run.durationMs)}</span>
                            {run.usageCaptured && run.totalTokens !== undefined && (
                              <span>{formatNumber(run.totalTokens)} tokens</span>
                            )}
                            {run.usageCaptured && run.meteredAiCredits !== undefined && (
                              <span className="tabular-nums" title="SDK-reported at worker shutdown">{formatCredits(run.meteredAiCredits)} metered AI credits</span>
                            )}
                            {run.usageCaptured && run.estimatedAiCredits !== undefined && (
                              <span className="tabular-nums" title="Estimated from the Copilot price card">{formatCredits(run.estimatedAiCredits)} est. AI credits</span>
                            )}
                            {!run.usageCaptured && <span>Usage unavailable</span>}
                            {run.deliveryStatus && <span>Parent delivery {run.deliveryStatus}</span>}
                          </div>
                          {run.error && <p className="mt-1 break-words text-xs text-error">{run.error}</p>}
                          {run.deliveryError && (
                            <p className="mt-1 break-words text-xs text-error">{run.deliveryError}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyHint>No worker checks recorded in the last seven days.</EmptyHint>
                )}
              </Section>

              <Section label="Parent deliveries" count={deliveries.length}>
                {deliveries.length > 0 ? (
                  <div className={DS.surface.divided}>
                    {deliveries.map((delivery) => (
                      <div key={delivery.id} className="flex items-start gap-2.5 px-3 py-2.5">
                        <DeliveryIcon delivery={delivery} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium text-text-primary">
                              {deferLabels.get(delivery.deferId) ?? delivery.deferId} · {statusLabel(delivery.status)}
                            </span>
                            <span
                              className="text-[10px] text-text-faint"
                              title={new Date(delivery.updatedAt).toLocaleString()}
                            >
                              {timeAgo(delivery.updatedAt)}
                            </span>
                          </div>
                          {delivery.error && (
                            <p className="mt-1 break-words text-xs text-error">{delivery.error}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyHint>No parent deliveries recorded in the last seven days.</EmptyHint>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
