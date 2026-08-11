import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Gauge, Loader2, RotateCw } from "lucide-react";
import type {
  CopilotQuotaStatus,
  CopilotUsageCoverage,
  CopilotUsageModelRow,
  CopilotUsageSkipReason,
  CopilotUsageTotals,
  CopilotUsageUnpricedModelRow,
} from "../../api";
import {
  COPILOT_USAGE_RANGE_DESCRIPTIONS,
  COPILOT_USAGE_RANGE_KEYS,
  COPILOT_USAGE_RANGE_LABELS,
  DEFAULT_COPILOT_USAGE_RANGE,
  type CopilotUsageRangeKey,
} from "../../../shared/copilot-usage-range";
import { COPILOT_USAGE_UNATTRIBUTED_MODEL } from "../../../shared/copilot-usage";
import { COPILOT_AI_CREDIT_USD } from "../../../shared/copilot-pricing";
import { useCopilotQuotaQuery } from "../../hooks/queries/useCopilotQuota";
import { useCopilotUsageQuery } from "../../hooks/queries/useCopilotUsage";
import EmptyState from "../shared/EmptyState";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "../shared/Skeleton";
import { SettingsSection } from "./SettingsSection";

const NUMBER_FORMATTER = new Intl.NumberFormat();
const USD_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const SMALL_USD_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});
const AI_CREDIT_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const SMALL_AI_CREDIT_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 4,
});
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
/**
 * Quota reset lands on a UTC calendar boundary. Rendering it in local time
 * shifts it a day backwards for anyone west of UTC, so it gets its own
 * UTC-pinned formatter rather than the ambient-timezone one.
 */
const UTC_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const SKIP_REASON_LABELS: Record<CopilotUsageSkipReason, string> = {
  no_events: "no events file",
  no_shutdown: "no shutdown summary",
  empty_model_metrics: "empty model metrics",
  parse_error: "parse errors",
};

const PRICING_STATUS_LABELS: Record<CopilotUsageModelRow["pricingStatus"], string> = {
  exact: "Exact public price",
  "sdk-name": "Matched SDK name",
  unpriced: "Unpriced",
};

export function CopilotUsageSection() {
  const [range, setRange] = useState<CopilotUsageRangeKey>(DEFAULT_COPILOT_USAGE_RANGE);
  const { data, error, isLoading, refresh } = useCopilotUsageQuery({ includeSessions: false, range });
  const quota = useCopilotQuotaQuery();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) {
      setRefreshError(null);
    }
  }, [error]);

  const handleRefresh = useCallback(async () => {
    setRefreshError(null);
    setRefreshing(true);
    try {
      await Promise.all([refresh(), quota.refresh().catch(() => undefined)]);
    } catch (refreshErr) {
      setRefreshError(formatError(refreshErr));
    } finally {
      setRefreshing(false);
    }
  }, [refresh, quota.refresh]);

  const indexing = data?.index.state === "scanning";
  const busy = refreshing || indexing || (isLoading && !data);
  const isEmpty = Boolean(data && data.models.length === 0 && data.coverage.sessionsIncluded === 0);
  const isRanged = Boolean(data?.range.startAt);
  // GitHub's own session metering. Older session logs predate the field, so a
  // range can be partially metered; the estimate stays the headline and the
  // metered figure carries its own coverage so it is never read as complete.
  const meteredAiCredits = data?.totals.meteredAiCredits ?? 0;
  const meteredTokens = data?.totals.meteredTokens ?? 0;
  const totalTokens = data?.totals.totalTokens ?? 0;
  const meteredCoverage = totalTokens > 0 ? meteredTokens / totalTokens : 0;
  const hasMeteredCost = meteredTokens > 0;
  const meteredCostUsd = meteredAiCredits * COPILOT_AI_CREDIT_USD;
  const reasonSummary = useMemo(
    () => (data ? formatSkipReasonSummary(data.coverage) : "Skipped session details will appear after the first successful scan."),
    [data],
  );

  return (
    <SettingsSection
      title="Local Copilot Usage"
      description="Estimated from local session history with GitHub Copilot public pricing assumptions. Not official billing."
      action={(
        <button
          onClick={() => void handleRefresh()}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            aria-label="Usage time range"
            className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border bg-bg-elevated p-1"
          >
            {COPILOT_USAGE_RANGE_KEYS.map((key) => {
              const selected = key === range;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRange(key)}
                  aria-pressed={selected}
                  title={COPILOT_USAGE_RANGE_DESCRIPTIONS[key]}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    selected
                      ? "bg-accent text-white"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  {COPILOT_USAGE_RANGE_LABELS[key]}
                </button>
              );
            })}
          </div>
          <div className="text-[11px] text-text-faint">
            {data ? formatRangeWindow(data.range.startAt) : COPILOT_USAGE_RANGE_DESCRIPTIONS[range]}
          </div>
        </div>

        <QuotaCard
          status={quota.data ?? null}
          isLoading={quota.isLoading && !quota.data}
          error={quota.error}
        />

        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
          Metered cost is what GitHub actually billed, read from each session log, and only covers sessions recent enough to carry that field. Cost that GitHub did not assign to a named model appears as Unattributed. Estimated cost is reconstructed from GitHub's public model pricing: uncached input, cache reads, cache writes, and output are priced separately, reasoning tokens are already counted inside output, and cache writes bill at 1.25x the input rate. Only persisted local session shutdown summaries on this device count toward coverage; active work after the latest persisted shutdown, unpersisted sessions, and other devices are excluded.
        </div>

        {data && indexing && (
          <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-3 text-xs text-text-secondary">
            <div className="flex items-center gap-2 font-medium text-accent">
              <Loader2 size={13} className="animate-spin" />
              Indexing local usage in the background
            </div>
            <p className="mt-1 text-text-muted">
              Checked {formatNumber(data.index.sessionsProcessed)} of {formatNumber(data.index.sessionsTotal)} sessions.
              Cached totals update progressively without keeping this request open.
            </p>
          </div>
        )}

        {data?.index.state === "error" && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-3 text-xs text-error">
            {data.index.error ?? "Local usage indexing failed. Previously cached totals are still shown."}
          </div>
        )}

        {data?.index.warning && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-3 text-xs text-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
            <span>{data.index.warning}</span>
          </div>
        )}

        {isLoading && !data && (
          <LoadingSkeletonRegion
            isLoading
            label="Scanning local Copilot session history"
            className="rounded-md border border-border bg-bg-elevated p-4 space-y-3"
          >
            <div>
              <p className="text-sm font-medium text-text-secondary">Scanning local Copilot session history…</p>
              <p className="mt-1 text-xs text-text-muted">
                Usage totals will appear after local shutdown summaries are scanned.
              </p>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
              {["Estimated cost", "AI credits", "Total tokens", "Requests", "Included sessions", "Coverage window"].map((label) => (
                <div key={label} className="rounded-md border border-border bg-bg-primary px-4 py-3">
                  <Skeleton height={10} width="54%" shape="pill" />
                  <Skeleton height={16} width="72%" shape="pill" className="mt-2" />
                </div>
              ))}
            </div>
            <div className="rounded-md border border-warning/20 bg-bg-primary p-3">
              <SkeletonText lines={2} widths={["64%", "86%"]} />
            </div>
          </LoadingSkeletonRegion>
        )}

        {!isLoading && !data && error && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-3 text-sm text-error">
            Failed to load local Copilot usage: {formatError(error)}
          </div>
        )}

        {data && (
          <>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
              <SummaryCard
                label="Estimated cost"
                value={formatCurrencyUsd(data.totals.estimatedCostUsd)}
                sub={`${formatAiCredits(data.totals.estimatedAiCredits)} credits${data.totals.unpricedModelCount > 0 ? " · excludes unpriced" : ""}`}
              />
              <SummaryCard
                label="Metered cost"
                value={hasMeteredCost ? formatCurrencyUsd(meteredCostUsd) : "Not recorded"}
                sub={hasMeteredCost
                  ? `Billed by GitHub · ${formatMeteredCoverage(meteredCoverage)}`
                  : "No GitHub metering in this range"}
              />
              <SummaryCard label="Total tokens" value={formatNumber(data.totals.totalTokens)} />
              <SummaryCard label="Requests" value={formatNumber(data.totals.requests)} />
              <SummaryCard label="Included sessions" value={formatNumber(data.coverage.sessionsIncluded)} />
              <SummaryCard label="Coverage window" value={formatCoverageWindow(data.coverage)} />
            </div>

            {data.totals.unpricedModelCount > 0 && (
              <UnpricedModelsWarning
                count={data.totals.unpricedModelCount}
                models={data.unpricedModels}
                unpricedTokens={data.totals.unpricedTokens}
              />
            )}

            <div className="rounded-md border border-warning/30 bg-warning/10 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-warning">
                    <AlertTriangle size={15} />
                    Coverage and exclusions
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    Included sessions come from shutdown summaries still present on disk. Resumed sessions keep their earlier persisted shutdown usage, but active work after the latest shutdown is still excluded.
                    {isRanged && " Counts are limited to sessions with recorded usage inside the selected window."}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-bg-primary px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                  {formatNumber(data.coverage.sessionsSkipped)} skipped
                </span>
              </div>

              <div className="grid gap-2 text-xs text-text-muted md:grid-cols-2 xl:grid-cols-4">
                <CoverageStat label="Sessions seen" value={formatNumber(data.coverage.sessionsSeen)} />
                <CoverageStat label="Events files found" value={formatNumber(data.coverage.sessionsWithEvents)} />
                <CoverageStat label="Included" value={formatNumber(data.coverage.sessionsIncluded)} />
                <CoverageStat label="Skipped" value={formatNumber(data.coverage.sessionsSkipped)} />
              </div>

              <div className="rounded-md border border-warning/20 bg-bg-primary px-3 py-2 text-xs text-text-muted">
                {reasonSummary}
              </div>
            </div>

            <div className="rounded-md border border-border bg-bg-elevated">
              <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-accent">
                    <BarChart3 size={15} />
                    Per-model totals
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    Session counts are per model and can add up to more than the included session total.
                  </p>
                </div>
                <div className="shrink-0 text-right text-[11px] text-text-faint">
                  Updated {formatDateTime(data.index.completedAt ?? data.generatedAt)}
                </div>
              </div>

              {isEmpty ? (
                <div className="p-4">
                  <EmptyState
                    message={isRanged ? "No local usage in this window" : "No persisted local usage yet"}
                    sub={isRanged
                      ? "Pick a wider range, or wait for sessions in this window to write a shutdown summary."
                      : "This view only includes completed sessions with shutdown summaries and model metrics still available on disk."}
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-max w-full text-xs">
                    <thead className="bg-bg-secondary text-text-muted">
                      <tr className="border-b border-border">
                        <th className="px-4 py-3 text-left font-medium">Model</th>
                        <th className="px-4 py-3 text-right font-medium">Sessions</th>
                        <th className="px-4 py-3 text-right font-medium">Requests</th>
                        <th className="px-4 py-3 text-right font-medium">Est. cost</th>
                        <th className="px-4 py-3 text-right font-medium">Est. credits</th>
                        <th className="px-4 py-3 text-right font-medium">Metered credits</th>
                        <th className="px-4 py-3 text-right font-medium">Pricing</th>
                        <th className="px-4 py-3 text-right font-medium">Total tokens</th>
                        <th className="px-4 py-3 text-right font-medium">Input</th>
                        <th className="px-4 py-3 text-right font-medium">Output</th>
                        <th className="px-4 py-3 text-right font-medium">Cache read</th>
                        <th className="px-4 py-3 text-right font-medium">Cache write</th>
                        <th className="px-4 py-3 text-right font-medium">Reasoning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.models.map((row) => (
                        <ModelRow key={`${row.model}:${row.contextTier ?? "default"}`} row={row} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {data && (refreshError || error) && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            Last refresh failed: {refreshError ?? formatError(error)}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-elevated px-4 py-3">
      <div className="text-[11px] font-medium tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-sm font-medium text-text-primary">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-text-faint">{sub}</div>}
    </div>
  );
}

/**
 * Live counter straight from the backend's `account.getQuota`. Unlike the local
 * estimate below it is real billing state, but it covers only the identity the
 * bridge authenticates as and resets on the quota period, not the picked range.
 */
function QuotaCard({
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
        className="rounded-md border border-border bg-bg-elevated p-4"
      >
        <Skeleton height={12} width="32%" shape="pill" />
        <Skeleton height={18} width="52%" shape="pill" className="mt-2" />
      </LoadingSkeletonRegion>
    );
  }

  const snapshot = status?.primary ?? null;
  if (!status?.available || !snapshot) {
    return (
      <div className="rounded-md border border-border bg-bg-elevated px-4 py-3 text-xs text-text-muted">
        <div className="flex items-center gap-2 text-sm font-medium text-text-secondary">
          <Gauge size={15} />
          Live account quota
        </div>
        <p className="mt-1">
          {status?.error ?? (error ? formatError(error) : "Live quota is unavailable right now. Local estimates below still apply.")}
        </p>
      </div>
    );
  }

  const unitLabel = snapshot.unit === "ai_credits" ? "AI credits" : "premium requests";
  const usedPercent = snapshot.remainingPercentage !== null
    ? Math.min(100, Math.max(0, 100 - snapshot.remainingPercentage))
    : null;
  const identity = status.identity;
  const identityLabel = [identity?.login, identity?.plan]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <Gauge size={15} />
            Live account quota
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Billed {unitLabel} for {identityLabel || "the identity this bridge signs in as"}, read from the Copilot backend. Covers every client on that account, not just the bridge, and resets on the quota period rather than the range picked above.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-bg-primary px-2 py-0.5 text-[10px] font-medium text-text-secondary">
          {snapshot.usedIsPrecise ? "Exact counter" : "Rounded counter"}
        </span>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label={`Used ${unitLabel}`}
          value={formatQuotaAmount(snapshot.used)}
          sub={snapshot.unit === "ai_credits" && snapshot.used !== null
            ? `${formatCurrencyUsd(snapshot.used * 0.01)} at $0.01 per credit`
            : undefined}
        />
        <SummaryCard
          label="Entitlement"
          value={snapshot.isUnlimitedEntitlement ? "Unlimited" : formatQuotaAmount(snapshot.entitlement)}
          sub={snapshot.overage ? `${formatQuotaAmount(snapshot.overage)} overage` : undefined}
        />
        <SummaryCard
          label="Remaining"
          value={formatQuotaAmount(snapshot.remaining)}
          sub={snapshot.remainingPercentage !== null ? `${formatPercent(snapshot.remainingPercentage)} left` : undefined}
        />
        <SummaryCard
          label="Resets"
          value={snapshot.resetAt ? formatUtcDate(snapshot.resetAt) ?? snapshot.resetAt : "Unknown"}
          sub={`Bucket ${snapshot.bucket}`}
        />
      </div>

      {usedPercent !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-primary">
          <div className="h-full rounded-full bg-accent" style={{ width: `${usedPercent}%` }} />
        </div>
      )}

      <div className="text-[11px] text-text-faint">
        Updated {formatDateTime(status.fetchedAt)}
        {snapshot.overagePermitted === true && " · overage permitted"}
      </div>
    </div>
  );
}

function CoverageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-warning/20 bg-bg-primary px-3 py-2">
      <div className="text-[11px] font-medium tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-sm font-medium text-text-primary">{value}</div>
    </div>
  );
}

function UnpricedModelsWarning({
  count,
  models,
  unpricedTokens,
}: {
  count: number;
  models: CopilotUsageUnpricedModelRow[];
  unpricedTokens: CopilotUsageTotals;
}) {
  return (
    <div className="rounded-md border border-warning/30 bg-warning/10 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-warning">Unknown pricing excluded from cost totals</div>
          <p className="mt-1 text-xs text-text-muted">
            GitHub public pricing did not include {formatNumber(count)} observed model{count === 1 ? "" : "s"}. These models remain visible below with token totals, and their estimated cost is excluded from summary totals. Excluded cost below is what GitHub actually metered for them, which is genuinely zero for free internal and alpha models.
          </p>
        </div>
      </div>

      <div className="grid gap-2 text-xs text-text-muted md:grid-cols-2 xl:grid-cols-4">
        <CoverageStat label="Unpriced tokens" value={formatNumber(unpricedTokens.totalTokens)} />
        <CoverageStat label="Unpriced requests" value={formatNumber(unpricedTokens.requests)} />
        <CoverageStat label="Unpriced models" value={formatNumber(count)} />
        <CoverageStat
          label="Excluded cost"
          value={formatCurrencyUsd(unpricedTokens.meteredAiCredits * COPILOT_AI_CREDIT_USD)}
        />
      </div>

      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.map((row) => (
            <span
              key={`${row.model}:${row.contextTier ?? "default"}`}
              className="rounded-full border border-warning/20 bg-bg-primary px-2 py-0.5 text-[11px] font-medium text-text-secondary"
            >
              {row.model}
              {row.contextTierLabel && (
                <span className="text-text-faint"> · {row.contextTierLabel}</span>
              )}
              {row.normalizedPricingModel && row.normalizedPricingModel !== row.model && (
                <span className="text-text-faint"> · normalized {row.normalizedPricingModel}</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelRow({ row }: { row: CopilotUsageModelRow }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-4 py-3 font-medium text-text-primary">
        <div>{row.model}</div>
        {row.contextTierLabel && (
          <div className="text-[11px] font-normal text-text-faint">{row.contextTierLabel}</div>
        )}
      </td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.sessions)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.requests)}</td>
      <td className="px-4 py-3 text-right font-medium text-text-primary">{formatCurrencyUsd(row.estimatedCostUsd)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatAiCredits(row.estimatedAiCredits)}</td>
      <td className="px-4 py-3 text-right text-text-muted">
        {row.meteredAiCredits > 0 || row.meteredTokens > 0 ? formatAiCredits(row.meteredAiCredits) : "—"}
      </td>
      <PricingStatusCell row={row} />
      <td className="px-4 py-3 text-right font-medium text-text-primary">{formatNumber(row.totalTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.inputTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.outputTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.cacheReadTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.cacheWriteTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.reasoningTokens)}</td>
    </tr>
  );
}

function PricingStatusCell({ row }: { row: CopilotUsageModelRow }) {
  if (row.model === COPILOT_USAGE_UNATTRIBUTED_MODEL) {
    return (
      <td className="px-4 py-3 text-right text-text-muted">
        <div className="flex flex-col items-end gap-1">
          <span className="rounded-full bg-bg-primary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
            Not model-attributed
          </span>
          <span className="text-[11px] text-text-faint">metered total only</span>
        </div>
      </td>
    );
  }

  const pricedAs = row.pricedAs ?? row.pricingKey;
  const showPricedAs = Boolean(pricedAs && pricedAs !== row.model);

  return (
    <td className="px-4 py-3 text-right text-text-muted">
      <div className="flex flex-col items-end gap-1">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${row.pricingStatus === "unpriced" ? "bg-warning/10 text-warning" : "bg-bg-primary text-text-secondary"}`}>
          {PRICING_STATUS_LABELS[row.pricingStatus] ?? row.pricingStatus}
        </span>
        {showPricedAs && (
          <span className="text-[11px] text-text-faint">priced as {pricedAs}</span>
        )}
        {row.pricingStatus === "unpriced" && (
          <span className="text-[11px] text-text-faint">excluded from cost</span>
        )}
      </div>
    </td>
  );
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatCurrencyUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return USD_FORMATTER.format(0);
  }
  if (value < 0.000001) {
    return "<$0.000001";
  }
  if (value < 0.01) {
    return SMALL_USD_FORMATTER.format(value);
  }
  return USD_FORMATTER.format(value);
}

function formatAiCredits(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 0.0001) {
    return "<0.0001";
  }
  if (value < 1) {
    return SMALL_AI_CREDIT_FORMATTER.format(value);
  }
  return AI_CREDIT_FORMATTER.format(value);
}

function formatQuotaAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  return AI_CREDIT_FORMATTER.format(value);
}

function formatPercent(value: number): string {
  return `${AI_CREDIT_FORMATTER.format(value)}%`;
}

function formatRangeWindow(startAt: string | null): string {
  if (!startAt) return "All local history";
  const start = formatDate(startAt);
  return start ? `Since ${start}` : "All local history";
}

function formatCoverageWindow(coverage: CopilotUsageCoverage): string {  if (!coverage.earliestIncludedAt || !coverage.latestIncludedAt) {
    return "No completed sessions";
  }

  const earliest = formatDate(coverage.earliestIncludedAt);
  const latest = formatDate(coverage.latestIncludedAt);
  if (!earliest || !latest) {
    return "Dates unavailable";
  }

  return `${earliest} → ${latest}`;
}

function formatSkipReasonSummary(coverage: CopilotUsageCoverage): string {
  const reasons = (Object.keys(SKIP_REASON_LABELS) as CopilotUsageSkipReason[])
    .map((reason) => ({
      reason,
      count: coverage.skippedByReason[reason] ?? 0,
    }))
    .filter(({ count }) => count > 0)
    .map(({ reason, count }) => `${formatNumber(count)} ${SKIP_REASON_LABELS[reason]}`);

  if (reasons.length === 0) {
    return "Skipped session buckets are empty for the latest scan. Sessions without a persisted shutdown summary still remain excluded.";
  }

  return `Skipped breakdown: ${reasons.join(" · ")}. Sessions without persisted shutdown summaries are excluded.`;
}

function formatDate(value: string): string | null {
  return formatTimestamp(value, DATE_FORMATTER);
}

/** Formats a UTC calendar date without shifting it into the viewer's timezone. */
function formatUtcDate(value: string): string | null {
  return formatTimestamp(value, UTC_DATE_FORMATTER);
}

/**
 * Describes how much of the range GitHub actually metered. Anything short of
 * full coverage has to say so, otherwise a partial figure reads as a total.
 */
function formatMeteredCoverage(coverage: number): string {
  if (coverage >= 0.999) return "covers all tokens in range";
  return `covers ${Math.round(coverage * 100)}% of tokens in range`;
}

function formatDateTime(value: string): string {
  return formatTimestamp(value, DATE_TIME_FORMATTER) ?? "Unknown time";
}

function formatTimestamp(value: string, formatter: Intl.DateTimeFormat): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatter.format(date);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
