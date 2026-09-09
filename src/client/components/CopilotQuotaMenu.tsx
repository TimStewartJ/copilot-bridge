import { useState } from "react";
import { Gauge, Loader2, RotateCw, X } from "lucide-react";
import type { CopilotQuotaStatus } from "../api";
import { useCopilotQuotaQuery } from "../hooks/queries/useCopilotQuota";
import { LoadingSkeletonRegion, Skeleton } from "./shared/Skeleton";
import { useModalDialog } from "./shared/useModalDialog";

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
  mobile?: boolean;
}

export default function CopilotQuotaMenu({ collapsed = false, mobile = false }: CopilotQuotaMenuProps) {
  const quota = useCopilotQuotaQuery();
  const [hovered, setHovered] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const status = quota.data ?? null;
  const snapshot = status?.primary ?? null;
  const usedPercent = getUsedPercent(snapshot);
  const accessibleLabel = snapshot
    ? `Live Copilot quota, ${formatQuotaAmount(snapshot.used)} ${getUnitLabel(snapshot)} used`
    : "Live Copilot quota";

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
          onClick={() => setDetailsOpen(true)}
          title="Open live Copilot quota"
          aria-label={accessibleLabel}
          className={collapsed
            ? "relative flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            : "relative flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"}
        >
          {quota.isLoading && !status ? <Loader2 size={collapsed ? 17 : 14} className="animate-spin" /> : <Gauge size={collapsed ? 17 : 14} />}
          {!collapsed && <span className="min-w-0 flex-1">Copilot quota</span>}
          {usedPercent !== null && (
            <span
              aria-hidden="true"
              className={collapsed
                ? "absolute inset-x-1.5 bottom-1 h-0.5 overflow-hidden rounded-full bg-bg-primary"
                : "h-1 w-12 overflow-hidden rounded-full bg-bg-primary"}
            >
              <span className="block h-full rounded-full bg-accent" style={{ width: `${usedPercent}%` }} />
            </span>
          )}
        </button>

        {hovered && !detailsOpen && !mobile && (
          <div
            role="tooltip"
            className={`absolute z-40 rounded-lg border border-border bg-bg-elevated p-3 text-xs shadow-xl ${
              collapsed
                ? "bottom-0 left-full ml-2 w-56"
                : "bottom-full left-0 mb-2 w-full min-w-[220px]"
            }`}
          >
            <QuotaHoverSummary
              status={status}
              isLoading={quota.isLoading && !status}
              error={quota.error}
            />
            <p className="mt-2 text-[10px] text-text-faint">Click for quota details</p>
          </div>
        )}
      </div>

      {detailsOpen && (
        <CopilotQuotaDetailsDialog
          status={status}
          isLoading={quota.isLoading && !status}
          error={quota.error}
          refreshing={refreshing}
          refreshError={refreshError}
          onRefresh={() => void handleRefresh()}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </>
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
        <p className="mt-1 text-text-muted">
          {status?.error ?? (error ? formatError(error) : "Unavailable right now")}
        </p>
      </>
    );
  }

  const usedPercent = getUsedPercent(snapshot);
  return (
    <>
      <div className="flex items-center gap-2 font-medium text-text-secondary">
        <Gauge size={14} className="text-accent" />
        Live account quota
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-base font-semibold tabular-nums text-text-primary">
          {formatUsedAmount(snapshot)}
        </span>
        <span className="text-text-muted">{getUnitLabel(snapshot)} used</span>
      </div>
      <p className="mt-0.5 text-text-muted">
        {snapshot.isUnlimitedEntitlement
          ? "Unlimited allowance"
          : `of ${formatQuotaAmount(snapshot.entitlement)} this period`}
      </p>
      {usedPercent !== null && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-text-muted">
          <span>{formatPercent(usedPercent)} used</span>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-bg-primary">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${usedPercent}%` }} />
          </span>
        </div>
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

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 md:items-start md:justify-center">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        {...dialogProps}
        className="relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-primary shadow-2xl md:mt-16 md:mb-16 md:max-w-lg md:rounded-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Gauge size={15} className="text-accent" />
            Live account quota
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted transition-colors hover:text-text-primary"
            aria-label="Close quota details"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <QuotaDetailsCard status={status} isLoading={isLoading} error={error} />
          {refreshError && (
            <div className="mt-3 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
              Refresh failed: {refreshError}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-[11px] text-text-faint">Current period · all clients</p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || isLoading}
            className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-70"
          >
            {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
            Refresh
          </button>
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
        className="rounded-lg border border-border bg-bg-elevated p-4"
      >
        <Skeleton height={12} width="32%" shape="pill" />
        <Skeleton height={18} width="52%" shape="pill" className="mt-2" />
      </LoadingSkeletonRegion>
    );
  }

  const snapshot = status?.primary ?? null;
  if (!status?.available || !snapshot) {
    return (
      <div className="rounded-lg border border-border bg-bg-elevated px-4 py-3 text-xs text-text-muted">
        <div className="flex items-center gap-2 text-sm font-medium text-text-secondary">
          <Gauge size={15} />
          Live account quota
        </div>
        <p className="mt-1">
          {status?.error ?? (error ? formatError(error) : "Live quota is unavailable right now.")}
        </p>
      </div>
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
    <div className="space-y-4 rounded-lg border border-border bg-bg-elevated p-4 sm:p-5">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-3xl font-semibold tracking-tight tabular-nums text-text-primary">
            {formatUsedAmount(snapshot)}
          </span>
          <span className="text-sm text-text-muted">{getUnitLabel(snapshot)} used</span>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          {snapshot.isUnlimitedEntitlement
            ? "Unlimited allowance"
            : `of ${formatQuotaAmount(snapshot.entitlement)} this period`}
        </p>
        {Boolean(snapshot.overage) && (
          <p className="mt-1 text-xs text-warning">{formatQuotaAmount(snapshot.overage)} overage</p>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <RateStat
          label="Current run rate"
          value={formatDailyRate(snapshot.used, snapshot, monthTimeline.elapsedDays)}
        />
        <RateStat
          label="To exhaust by month end"
          value={formatExhaustionRate(snapshot, monthTimeline.remainingDays)}
        />
      </div>

      {usedPercent !== null && (
        <div className="space-y-1.5">
          <div
            className="w-full overflow-hidden rounded-full bg-bg-primary"
            role="img"
            aria-label={`${formatPercent(usedPercent)} quota used; ${formatPercent(monthElapsedPercent)} of calendar month elapsed`}
          >
            <div className="h-1 rounded-r-full bg-accent" style={{ width: `${usedPercent}%` }} />
            <div className="h-1 rounded-r-full bg-sky-400" style={{ width: `${monthElapsedPercent}%` }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
              {formatPercent(usedPercent)} used
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-sky-400" />
              {formatPercent(monthElapsedPercent)} of month elapsed
            </span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-[11px] text-text-faint">
        <span className="min-w-0 break-all">{identityLabel || "Signed-in account"}</span>
        <span>Updated {formatDateTime(status.fetchedAt)}</span>
      </div>
    </div>
  );
}

function RateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
      <div className="text-[11px] font-medium tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-sm font-medium text-text-primary">{value}</div>
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

function getUsedPercent(snapshot: CopilotQuotaStatus["primary"]): number | null {
  if (!snapshot || snapshot.remainingPercentage === null) return null;
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
