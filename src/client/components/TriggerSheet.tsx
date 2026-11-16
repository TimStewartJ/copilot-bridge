import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import type { Session, TriggerDeliveryView, TriggerView, TriggerWorkerRun } from "../api";
import { DEFER_CHECKPOINT_MAX_BYTES, type DeferCheckpoint } from "../../shared/defer-checkpoint.js";
import { useSessionTriggersQuery, useTriggerActionMutation, type TriggerAction } from "../hooks/queries/useTriggers";
import { writeClipboardText } from "../lib/clipboard";
import {
  formatTriggerWhen,
  isTriggerLive,
  pluralize,
  TRIGGER_CHECK_OUTCOME_LABEL,
  TRIGGER_THEN_LABEL,
  triggerLabel,
  triggerStatusKind,
  triggerStatusLabel,
} from "../lib/trigger-presentation";
import { timeAgo } from "../time";
import JsonTree from "./shared/JsonTree";
import { useModalDialog } from "./shared/useModalDialog";
import { DS, cx } from "../design/tokens";
import { Badge, Button, EmptyHint, IconButton, MetaLine, Notice, Section, StatusIcon } from "../design/primitives";
import { formatUsageCredits as formatCredits, formatUsageNumber as formatNumber } from "../lib/usage-presentation";

interface TriggerSheetProps {
  session: Pick<Session, "sessionId" | "summary">;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}

const CHECKPOINT_NEAR_LIMIT_RATIO = 0.8;
const COPY_FEEDBACK_MS = 2_000;

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const kilobytes = bytes / 1_024;
  return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
}

function runLabel(run: TriggerWorkerRun): string {
  switch (run.action) {
    case "continue": return "Continued";
    case "notify": return "Told the chat and continued";
    case "finish": return "Finished quietly";
    case "return": return "Returned to the chat";
    case "expired": return "Expired";
    case "error": return "Failed";
  }
}

function RunIcon({ run }: { run: TriggerWorkerRun }) {
  if (run.action === "error") return <XCircle size={14} className="shrink-0 text-error" aria-hidden="true" />;
  if (run.action === "continue" || run.action === "notify") {
    return <Clock size={14} className="shrink-0 text-text-faint" aria-hidden="true" />;
  }
  return <CheckCircle2 size={14} className="shrink-0 text-success" aria-hidden="true" />;
}

function DeliveryIcon({ delivery }: { delivery: TriggerDeliveryView }) {
  if (delivery.status === "failed") return <XCircle size={14} className="shrink-0 text-error" aria-hidden="true" />;
  if (delivery.status === "pending" || delivery.status === "running") {
    return <Clock size={14} className="shrink-0 text-text-faint" aria-hidden="true" />;
  }
  return <CheckCircle2 size={14} className="shrink-0 text-success" aria-hidden="true" />;
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
    <IconButton label={COPY_LABELS[copyState]} onClick={copy}>
      {copyState === "copied" && <Check size={13} className="text-copy-success" />}
      {copyState === "failed" && <AlertTriangle size={13} className="text-error" />}
      {copyState === "idle" && <Copy size={13} />}
    </IconButton>
  );
}

function CheckpointPreview({ checkpoint, live }: { checkpoint: DeferCheckpoint; live: boolean }) {
  const [open, setOpen] = useState(live);
  const keyCount = Object.keys(checkpoint).length;
  const bytes = new TextEncoder().encode(JSON.stringify(checkpoint)).length;
  const label = live ? "Checkpoint" : "Last checkpoint";
  const nearLimit = bytes >= DEFER_CHECKPOINT_MAX_BYTES * CHECKPOINT_NEAR_LIMIT_RATIO;

  return (
    <div className={cx(DS.surface.detail, "mt-3 overflow-hidden")}>
      <div className="flex items-center justify-between gap-2 py-1.5 pl-2.5 pr-1.5">
        <div className="flex min-w-0 items-center gap-2 text-[11px]" title="Private JSON state the worker passes to its next run">
          <span className="shrink-0 text-xs font-semibold text-text-primary">{label}</span>
          <span className={cx("truncate", nearLimit ? "text-warning" : "text-text-muted")}>
            {pluralize(keyCount, "key")} · {formatBytes(bytes)} of {formatBytes(DEFER_CHECKPOINT_MAX_BYTES)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <CopyCheckpointButton checkpoint={checkpoint} />
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
            {open ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {open && (
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

function CheckLine({ trigger }: { trigger: TriggerView }) {
  const { check, lastCheck } = trigger;
  if (!check) return null;
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-text-muted">
      <span>Check</span>
      <code className={cx(DS.text.literal, "min-w-0 break-all")} title={check.cwd}>{check.command.join(" ")}</code>
      <span>{check.fireOn === "exit_code" ? "Fires on exit code" : "Fires on change"}</span>
      {lastCheck ? (
        <span title={new Date(lastCheck.at).toLocaleString()}>
          {TRIGGER_CHECK_OUTCOME_LABEL[lastCheck.outcome]} {timeAgo(lastCheck.at)}
          {lastCheck.exitCode !== undefined ? ` · exit ${lastCheck.exitCode}` : ""}
          {lastCheck.actionPending ? " · action pending" : ""}
        </span>
      ) : (
        <span>Not run yet</span>
      )}
    </div>
  );
}

function TriggerCard({
  trigger,
  busy,
  onAction,
}: {
  trigger: TriggerView;
  busy: boolean;
  onAction: (action: TriggerAction, id: string) => void;
}) {
  const live = isTriggerLive(trigger.status);
  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{triggerLabel(trigger)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge>
              <StatusIcon kind={triggerStatusKind(trigger.status)} decorative />
              {triggerStatusLabel(trigger.status)}
            </Badge>
            <MetaLine items={[
              formatTriggerWhen(trigger.when, trigger.whenLabel),
              TRIGGER_THEN_LABEL[trigger.then],
              trigger.runNow ? "Runs now" : trigger.nextRunAt && (
                <span title={new Date(trigger.nextRunAt).toLocaleString()}>Next {timeAgo(trigger.nextRunAt)}</span>
              ),
            ]} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {trigger.canRun && (
            <Button size="sm" disabled={busy} icon={<Play size={11} />} onClick={() => onAction("run", trigger.id)}>Run now</Button>
          )}
          {trigger.canPause && (
            <Button size="sm" disabled={busy} icon={<Pause size={11} />} onClick={() => onAction("pause", trigger.id)}>Pause</Button>
          )}
          {trigger.canResume && (
            <Button size="sm" disabled={busy} icon={<Play size={11} />} onClick={() => onAction("resume", trigger.id)}>Resume</Button>
          )}
          {trigger.canCancel && (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => onAction("cancel", trigger.id)}>Cancel</Button>
          )}
          {trigger.canReactivate && (
            <Button size="sm" disabled={busy} icon={<RotateCcw size={11} />} onClick={() => onAction("reactivate", trigger.id)}>
              {trigger.failedDelivery ? "Send result again" : "Reactivate"}
            </Button>
          )}
        </div>
      </div>

      {trigger.checkpoint && <CheckpointPreview checkpoint={trigger.checkpoint} live={live} />}

      <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
        {trigger.prompt}
      </p>

      <CheckLine trigger={trigger} />

      <MetaLine
        className="mt-3 border-t border-border pt-2"
        items={[
          `${pluralize(trigger.runCount, "run")}${trigger.maxRuns !== undefined ? ` of ${trigger.maxRuns}` : ""}`,
          trigger.check ? `${trigger.fireCount} fired` : null,
          trigger.attempts > 0 && `${trigger.attempts} failed in a row`,
          trigger.expiresAt && (
            <span title={new Date(trigger.expiresAt).toLocaleString()}>Ends {timeAgo(trigger.expiresAt)}</span>
          ),
        ]}
      />

      {trigger.lastError && (
        // On a trigger that is still going, the last error is why it is waiting or what its last check hit.
        <Notice tone={live ? "warning" : "danger"} icon={<AlertTriangle size={12} />} className="mt-2">
          {trigger.lastError}
        </Notice>
      )}
    </div>
  );
}

export default function TriggerSheet({
  session,
  onClose,
  restoreFocusTo,
}: TriggerSheetProps) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const query = useSessionTriggersQuery(session.sessionId);
  const actionMutation = useTriggerActionMutation();
  const [actionError, setActionError] = useState<string | null>(null);
  const triggers = query.data?.triggers ?? [];
  const live = triggers.filter((trigger) => isTriggerLive(trigger.status));
  const stopped = triggers.filter((trigger) => !isTriggerLive(trigger.status));
  const runs = query.data?.recentRuns ?? [];
  const deliveries = query.data?.recentDeliveries ?? [];
  const labels = new Map(triggers.map((trigger) => [trigger.id, triggerLabel(trigger)]));

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

  const act = async (action: TriggerAction, id: string) => {
    setActionError(null);
    try {
      await actionMutation.mutateAsync({ action, id });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The trigger could not be changed.");
    }
  };
  const renderCards = (items: TriggerView[]) => (
    <div className={DS.surface.divided}>
      {items.map((trigger) => (
        <TriggerCard
          key={trigger.id}
          trigger={trigger}
          busy={actionMutation.isPending}
          onAction={(action, id) => { void act(action, id); }}
        />
      ))}
    </div>
  );

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
            <h2 id={titleId} className="text-base font-semibold text-text-primary">Triggers</h2>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              {session.summary || session.sessionId.slice(0, 8)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <IconButton
              label="Refresh triggers"
              size="md"
              onClick={() => { void query.refetch(); }}
              disabled={query.isFetching}
            >
              <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
            </IconButton>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className={cx(DS.button.base, DS.button.icon.md, DS.button.variant.ghost)}
              aria-label="Close triggers"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {(actionError || query.error) && (
            <Notice tone="danger" icon={<AlertTriangle size={14} />}>
              {actionError || (query.error instanceof Error ? query.error.message : "Failed to load triggers.")}
            </Notice>
          )}

          {query.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading triggers
            </div>
          ) : triggers.length === 0 && runs.length === 0 && deliveries.length === 0 ? (
            <EmptyHint>No triggers.</EmptyHint>
          ) : (
            <>
              <Section label="Active" count={live.length}>
                {live.length > 0 ? renderCards(live) : <EmptyHint>No active triggers.</EmptyHint>}
              </Section>

              {stopped.length > 0 && (
                <Section label="Stopped" count={stopped.length}>
                  {renderCards(stopped)}
                </Section>
              )}

              <Section label="Worker runs" count={runs.length}>
                {runs.length > 0 ? (
                  <div className={DS.surface.divided}>
                    {runs.map((run) => (
                      <div key={run.id} className="flex items-start gap-2.5 px-3 py-2.5">
                        <RunIcon run={run} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium text-text-primary">
                              {labels.get(run.triggerId) ?? run.triggerId} · {runLabel(run)}
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
                            {run.deliveryStatus && <span>Delivery {run.deliveryStatus}</span>}
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
                  <EmptyHint>No worker runs in the last seven days.</EmptyHint>
                )}
              </Section>

              <Section label="Deliveries" count={deliveries.length}>
                {deliveries.length > 0 ? (
                  <div className={DS.surface.divided}>
                    {deliveries.map((delivery) => (
                      <div key={delivery.id} className="flex items-start gap-2.5 px-3 py-2.5">
                        <DeliveryIcon delivery={delivery} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium text-text-primary">
                              {labels.get(delivery.triggerId) ?? delivery.triggerId} · {triggerStatusLabel(delivery.status)}
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
                  <EmptyHint>No deliveries in the last seven days.</EmptyHint>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
