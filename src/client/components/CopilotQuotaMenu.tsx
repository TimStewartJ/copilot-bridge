import { useId, useState } from "react";
import { AlertTriangle, ChevronRight, Gauge, Loader2, RotateCw, X } from "lucide-react";
import type { CopilotQuotaStatus } from "../api";
import { useCopilotQuotaQuery } from "../hooks/queries/useCopilotQuota";
import { LoadingSkeletonRegion, Skeleton } from "./shared/Skeleton";
import { useModalDialog } from "./shared/useModalDialog";
import { DS, cx } from "../design/tokens";
import { Button, Field, FieldList, IconButton, MetaLine, Notice } from "../design/primitives";

// The reading and calendar reference stay distinct without making ordinary usage a coloured state.
const USAGE_COLOR_CLASS = "bg-text-secondary";
const MONTH_COLOR_CLASS = "bg-text-faint";
const MONTH_UNDERLAY_CLASS = "bg-text-faint/25";

const AI_CREDIT_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

interface CopilotQuotaMenuProps {
  collapsed?: boolean;
}

function useQuotaDetails() {
  const quota = useCopilotQuotaQuery();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const status = quota.data ?? null;
  const snapshot = status?.available ? status.primary : null;
  const isLoading = quota.isLoading && !status;

  const handleRefresh = async () => {
    setRefreshError(null);
    setRefreshing(true);
    try {
      await quota.refresh();
    } catch (error) {
      setRefreshError(formatError(error));
    } finally {
      setRefreshing(false);
    }
  };

  return {
    status,
    snapshot,
    isLoading,
    error: quota.error,
    usedPercent: getUsedPercent(snapshot),
    monthElapsedPercent: getMonthElapsedPercent(new Date()),
    accessibleLabel: snapshot
      ? `${quota.error ? "Cached" : "Live"} Copilot quota, ${formatUsedAmount(snapshot)} ${getUnitLabel(snapshot)} used`
      : "Live Copilot quota",
    detailsOpen,
    openDetails: () => setDetailsOpen(true),
    dialog: detailsOpen ? (
      <CopilotQuotaDetailsDialog
        status={status}
        isLoading={isLoading}
        error={quota.error}
        refreshing={refreshing}
        refreshError={refreshError}
        onRefresh={() => void handleRefresh()}
        onClose={() => setDetailsOpen(false)}
      />
    ) : null,
  };
}

export default function CopilotQuotaMenu({ collapsed = false }: CopilotQuotaMenuProps) {
  const details = useQuotaDetails();
  const [hovered, setHovered] = useState(false);
  const tooltipId = useId();
  const { status, isLoading, usedPercent } = details;

  return (
    <>
      <div
        className="relative"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        <button
          type="button"
          onClick={details.openDetails}
          title="Open live Copilot quota"
          aria-label={details.accessibleLabel}
          aria-haspopup="dialog"
          aria-expanded={details.detailsOpen}
          aria-describedby={hovered && !details.detailsOpen ? tooltipId : undefined}
          className={cx(
            DS.focus,
            collapsed
              ? "relative flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
              : "relative flex min-h-11 w-full items-center gap-2 rounded-md px-3 pb-3 pt-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary",
          )}
        >
          {isLoading ? <Loader2 size={collapsed ? 17 : 14} className="animate-spin" />
            : details.error ? <AlertTriangle size={collapsed ? 17 : 14} className="text-warning" aria-hidden="true" />
              : <Gauge size={collapsed ? 17 : 14} aria-hidden="true" />}
          {!collapsed && <span className="min-w-0 flex-1">Copilot quota</span>}
          {!collapsed && usedPercent !== null && <span className="tabular-nums">{formatPercent(usedPercent)}</span>}
          {usedPercent !== null && (
            <QuotaPaceBar
              usedPercent={usedPercent}
              monthPercent={details.monthElapsedPercent}
              className={collapsed ? "absolute inset-x-1.5 bottom-1 h-[3px]" : "absolute inset-x-3 bottom-1.5 h-[3px]"}
            />
          )}
        </button>

        {hovered && !details.detailsOpen && (
          <div
            id={tooltipId}
            role="tooltip"
            className={cx("absolute z-40 p-3 text-xs", DS.surface.floating,
              collapsed ? "bottom-0 left-full ml-2 w-56" : "bottom-full left-0 mb-2 w-full min-w-[220px]",
            )}
          >
            <QuotaHoverSummary
              status={status}
              isLoading={isLoading}
              error={details.error}
            />
            {details.error && status?.available && <p className="mt-2 text-xs text-warning">Last refresh failed; showing the previous reading.</p>}
            <p className="mt-2 text-xs text-text-secondary">Click for quota details</p>
          </div>
        )}
      </div>

      {details.dialog}
    </>
  );
}

/** The quota as a tappable summary for places without a rail to hover, such as mobile Settings. */
export function CopilotQuotaCard({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const details = useQuotaDetails();
  const { status, snapshot, isLoading, usedPercent } = details;
  const available = Boolean(status?.available && snapshot);

  if (compact) {
    return (
      <>
        <Button variant="ghost" size="sm" className={className} onClick={details.openDetails}
          aria-label={details.accessibleLabel} aria-haspopup="dialog" aria-expanded={details.detailsOpen}
          icon={isLoading ? <Loader2 size={14} className="animate-spin" /> : details.error
            ? <AlertTriangle size={14} className="text-warning" /> : <Gauge size={14} />}>
          Quota {available && usedPercent !== null && <span className="tabular-nums">{formatPercent(usedPercent)}</span>}
        </Button>
        {details.dialog}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={details.openDetails}
        aria-label={details.accessibleLabel}
        aria-haspopup="dialog"
        aria-expanded={details.detailsOpen}
        className={cx(DS.surface.panel, DS.focus, "block w-full px-4 py-3 text-left transition-colors hover:bg-bg-hover/60", className)}
      >
        <span className="flex items-center gap-2">
          {isLoading
            ? <Loader2 size={15} className="shrink-0 animate-spin text-text-secondary" />
            : <Gauge size={15} className="shrink-0 text-text-secondary" />}
          <span className="min-w-0 flex-1 text-[13px] font-medium text-text-primary">Copilot quota</span>
          {available && usedPercent !== null && (
            <span className="text-xs tabular-nums text-text-secondary">{formatPercent(usedPercent)} used</span>
          )}
          <ChevronRight size={13} className={DS.row.chevron} aria-hidden="true" />
        </span>
        {isLoading ? (
          <span className="mt-1 block text-xs text-text-secondary">Reading live Copilot quota…</span>
        ) : !available || !snapshot ? (
          <span className="mt-1 block text-xs text-text-secondary">
            {status?.error ?? (details.error ? formatError(details.error) : "Unavailable right now")}
          </span>
        ) : usedPercent === null ? (
          <span className="mt-1 block text-xs text-text-secondary">{formatUsedOfAllowance(snapshot)}</span>
        ) : (
          <>
            <QuotaPaceBar
              usedPercent={usedPercent}
              monthPercent={details.monthElapsedPercent}
              className="mt-3 h-1.5 w-full"
            />
            <QuotaPaceLegend
              usedLabel={formatUsedOfAllowance(snapshot)}
              monthPercent={details.monthElapsedPercent}
              className="mt-2"
            />
          </>
        )}
        {details.error && available && <span className="mt-2 block text-xs text-warning">Last refresh failed; showing the previous reading.</span>}
      </button>

      {details.dialog}
    </>
  );
}

/**
 * One track, two fills: quota used, drawn over how much of the month has gone by. Usage that runs ahead
 * covers the month fill, so a marker keeps the month readable. The layers share one grid cell, which
 * leaves positioning of the track itself to the caller.
 */
function QuotaPaceBar({
  usedPercent,
  monthPercent,
  className = "",
}: {
  usedPercent: number;
  monthPercent: number;
  className?: string;
}) {
  const layer = "col-start-1 row-start-1";
  return (
    <span
      aria-hidden="true"
      data-quota-pace-bar=""
      className={cx("grid overflow-hidden rounded-full bg-bg-hover", className)}
    >
      <span
        data-quota-fill="month"
        className={`${layer} rounded-r-full ${MONTH_UNDERLAY_CLASS}`}
        style={{ width: `${monthPercent}%` }}
      />
      <span
        data-quota-fill="usage"
        className={`${layer} rounded-r-full ${USAGE_COLOR_CLASS}`}
        style={{ width: `${usedPercent}%`, minWidth: usedPercent > 0 ? 2 : undefined }}
      />
      {usedPercent >= monthPercent && (
        <span
          data-quota-fill="month-marker"
          className={`${layer} w-0.5 -translate-x-1/2 ring-1 ring-bg-hover ${MONTH_COLOR_CLASS}`}
          style={{ marginLeft: `${monthPercent}%` }}
        />
      )}
    </span>
  );
}

function QuotaPaceLegend({
  usedLabel,
  monthPercent,
  className = "",
}: {
  usedLabel: string;
  monthPercent: number;
  className?: string;
}) {
  return (
    <span className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-text-secondary ${className}`}>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${USAGE_COLOR_CLASS}`} />
        {usedLabel}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${MONTH_COLOR_CLASS}`} />
        {formatWholePercent(monthPercent)} of month
      </span>
    </span>
  );
}

function QuotaHoverSummary({
  status,
  isLoading,
  error,
}: {
  status: CopilotQuotaStatus | null;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-text-secondary">
        <Loader2 size={13} className="animate-spin" />
        Reading live Copilot quota…
      </div>
    );
  }

  const snapshot = status?.primary ?? null;
  if (!status?.available || !snapshot) {
    return (
      <>
        <div className="flex items-center gap-2 font-medium text-text-secondary">
          <Gauge size={14} />
          Live account quota
        </div>
        <p className="mt-1 text-text-secondary">
          {status?.error ?? (error ? formatError(error) : "Unavailable right now")}
        </p>
      </>
    );
  }

  const usedPercent = getUsedPercent(snapshot);
  const monthElapsedPercent = getMonthElapsedPercent(new Date());
  return (
    <>
      <div className="flex items-center gap-2 font-medium text-text-secondary">
        <Gauge size={14} className="text-text-secondary" />
        Live account quota
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-base font-semibold tabular-nums text-text-primary">
          {formatUsedAmount(snapshot)}
        </span>
        <span className="text-text-secondary">{getUnitLabel(snapshot)} used</span>
      </div>
      <p className="mt-0.5 text-text-secondary">
        {snapshot.isUnlimitedEntitlement
          ? "Unlimited allowance"
          : `of ${formatQuotaAmount(snapshot.entitlement)} this period`}
      </p>
      {usedPercent !== null && (
        <>
          <QuotaPaceBar
            usedPercent={usedPercent}
            monthPercent={monthElapsedPercent}
            className="mt-2.5 h-1 w-full"
          />
          <QuotaPaceLegend
            usedLabel={`${formatPercent(usedPercent)} used`}
            monthPercent={monthElapsedPercent}
            className="mt-1.5"
          />
        </>
      )}
    </>
  );
}

function CopilotQuotaDetailsDialog({
  status,
  isLoading,
  error,
  refreshing,
  refreshError,
  onRefresh,
  onClose,
}: {
  status: CopilotQuotaStatus | null;
  isLoading: boolean;
  error: unknown;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });
  const failedRefresh = refreshError ?? (status?.available && error ? formatError(error) : null);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 md:items-start md:justify-center">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        {...dialogProps}
        className={cx(DS.surface.compactSheet, "overflow-hidden")}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Gauge size={15} className="text-text-secondary" aria-hidden="true" />
            Live account quota
          </h2>
          <IconButton label="Close quota details" onClick={onClose} title="Close"><X size={16} aria-hidden="true" /></IconButton>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <QuotaDetailsCard status={status} isLoading={isLoading} error={error} />
          {failedRefresh && (
            <Notice tone="danger" icon={<AlertTriangle size={14} />} className="mt-3">
              Refresh failed: {failedRefresh}. The previous reading is still shown.
            </Notice>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className={DS.usage.meta}>Current period · all clients</p>
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing || isLoading}
            icon={refreshing ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}>
            Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}

function QuotaDetailsCard({
  status,
  isLoading,
  error,
}: {
  status: CopilotQuotaStatus | null;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) {
    return (
      <LoadingSkeletonRegion
        isLoading
        label="Reading live Copilot quota"
        className="space-y-3"
      >
        <Skeleton height={12} width="32%" shape="pill" />
        <Skeleton height={18} width="52%" shape="pill" className="mt-2" />
      </LoadingSkeletonRegion>
    );
  }

  const snapshot = status?.primary ?? null;
  if (!status?.available || !snapshot) {
    return (
      <Notice tone="warning" icon={<AlertTriangle size={14} />} title="Live account quota unavailable">
        {status?.error ?? (error ? formatError(error) : "Live quota is unavailable right now. Try Refresh to read it again.")}
      </Notice>
    );
  }

  const usedPercent = getUsedPercent(snapshot);
  const monthElapsedPercent = getMonthElapsedPercent(new Date());
  const monthTimeline = getMonthTimeline(new Date());
  const identity = status.identity;
  const identityLabel = [identity?.login, identity?.plan]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={cx(DS.text.pageTitle, "tabular-nums")}>{formatUsedAmount(snapshot)}</span>
          <span className="text-sm text-text-secondary">{getUnitLabel(snapshot)} used</span>
        </div>
        <p className={cx(DS.usage.prose, "mt-1")}>
          {snapshot.isUnlimitedEntitlement ? "Unlimited allowance" : `of ${formatQuotaAmount(snapshot.entitlement)} this period`}
        </p>
        {Boolean(snapshot.overage) && (
          <p className="mt-1 text-xs tabular-nums text-warning">{formatQuotaAmount(snapshot.overage)} overage</p>
        )}
      </div>
      {usedPercent !== null && (
        <div role="img" aria-label={`${formatPercent(usedPercent)} quota used; ${formatPercent(monthElapsedPercent)} of calendar month elapsed`}>
          <QuotaPaceBar usedPercent={usedPercent} monthPercent={monthElapsedPercent} className="h-1.5 w-full" />
          <QuotaPaceLegend usedLabel={`${formatPercent(usedPercent)} used`} monthPercent={monthElapsedPercent} className="mt-2" />
        </div>
      )}
      <FieldList>
        <Field label="Remaining">
          <span className="tabular-nums">{snapshot.isUnlimitedEntitlement ? "Unlimited allowance" : `${formatQuotaAmount(getRemainingAmount(snapshot))} ${getUnitLabel(snapshot)}`}</span>
        </Field>
        <Field label="Resets">{snapshot.resetAt ? formatDateTime(snapshot.resetAt) : "Not reported"}</Field>
        <Field label="Current run rate">
          <span className="tabular-nums">{formatDailyRate(snapshot.used, snapshot, monthTimeline.elapsedDays)}</span>
        </Field>
        <Field label="To exhaust by month end">
          <span className="tabular-nums">{formatExhaustionRate(snapshot, monthTimeline.remainingDays)}</span>
        </Field>
      </FieldList>
      <p className={DS.usage.prose}>Quota covers this account across clients. Pace compares usage with the calendar month; it is not a spending forecast.</p>
      <MetaLine items={[identityLabel || "Signed-in account", `Updated ${formatDateTime(status.fetchedAt)}`]} />
    </div>
  );
}

function getUnitLabel(snapshot: CopilotQuotaStatus["primary"]): string {
  return snapshot?.unit === "ai_credits" ? "AI credits" : "premium requests";
}

function formatUsedAmount(snapshot: NonNullable<CopilotQuotaStatus["primary"]>): string {
  const prefix = !snapshot.usedIsPrecise && snapshot.used !== null ? "~" : "";
  return `${prefix}${formatQuotaAmount(snapshot.used)}`;
}

function formatUsedOfAllowance(snapshot: NonNullable<CopilotQuotaStatus["primary"]>): string {
  return snapshot.isUnlimitedEntitlement
    ? `${formatUsedAmount(snapshot)} ${getUnitLabel(snapshot)} used · Unlimited allowance`
    : `${formatUsedAmount(snapshot)} of ${formatQuotaAmount(snapshot.entitlement)} ${getUnitLabel(snapshot)}`;
}

function getUsedPercent(snapshot: CopilotQuotaStatus["primary"]): number | null {
  if (!snapshot || snapshot.isUnlimitedEntitlement || snapshot.remainingPercentage === null || !Number.isFinite(snapshot.remainingPercentage)) return null;
  return Math.min(100, Math.max(0, 100 - snapshot.remainingPercentage));
}

function formatDailyRate(
  amount: number | null,
  snapshot: NonNullable<CopilotQuotaStatus["primary"]>,
  days: number,
): string {
  if (amount === null || !Number.isFinite(amount)) return "Unknown";
  return `${formatQuotaAmount(amount / days)} ${getUnitLabel(snapshot)}/day`;
}

function formatExhaustionRate(
  snapshot: NonNullable<CopilotQuotaStatus["primary"]>,
  remainingDays: number,
): string {
  if (snapshot.isUnlimitedEntitlement) return "Unlimited allowance";
  const remaining = getRemainingAmount(snapshot);
  if (remaining === null) return "Unknown";
  if (remainingDays <= 0) return remaining > 0 ? "No days left" : "Exhausted";
  return formatDailyRate(remaining, snapshot, remainingDays);
}

function getRemainingAmount(snapshot: NonNullable<CopilotQuotaStatus["primary"]>): number | null {
  if (snapshot.remaining !== null && Number.isFinite(snapshot.remaining)) {
    return Math.max(0, snapshot.remaining);
  }
  if (snapshot.entitlement !== null && snapshot.used !== null
    && Number.isFinite(snapshot.entitlement) && Number.isFinite(snapshot.used)) {
    return Math.max(0, snapshot.entitlement - snapshot.used);
  }
  return null;
}

function getMonthTimeline(now: Date): { elapsedDays: number; remainingDays: number } {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const elapsedDays = Math.max(1, (now.getTime() - monthStart.getTime()) / 86_400_000);
  const remainingDays = Math.max(0, (nextMonthStart.getTime() - now.getTime()) / 86_400_000);
  return { elapsedDays, remainingDays };
}

function formatQuotaAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  return AI_CREDIT_FORMATTER.format(value);
}

function formatPercent(value: number): string {
  return `${AI_CREDIT_FORMATTER.format(value)}%`;
}

function formatWholePercent(value: number): string {
  return `${Math.round(value)}%`;
}

function getMonthElapsedPercent(now: Date): number {
  const current = Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );
  const monthStart = Date.UTC(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = Date.UTC(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.min(100, Math.max(0, ((current - monthStart) / (nextMonthStart - monthStart)) * 100));
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : DATE_TIME_FORMATTER.format(date);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
