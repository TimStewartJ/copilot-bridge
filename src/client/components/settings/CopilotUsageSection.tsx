import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Loader2, RotateCw } from "lucide-react";
import type {
  CopilotUsageCoverage,
  CopilotUsageModelRow,
  CopilotUsageSkipReason,
  CopilotUsageTotals,
  CopilotUsageUnpricedModelRow,
} from "../../api";
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
  "normalized-variant": "Variant priced",
  unpriced: "Unpriced",
};

export function CopilotUsageSection() {
  const { data, error, isLoading, refresh } = useCopilotUsageQuery();
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
      await refresh();
    } catch (refreshErr) {
      setRefreshError(formatError(refreshErr));
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const busy = refreshing || (isLoading && !data);
  const isEmpty = Boolean(data) && data.models.length === 0 && data.coverage.sessionsIncluded === 0;
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
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
          Local estimate only. Costs use GitHub's public Copilot model pricing, assume reasoning tokens are priced at the output rate, and convert AI credits at $0.01 per credit. Only persisted local session shutdown summaries on this device count toward coverage; active work after the latest persisted shutdown, unpersisted sessions, and other devices are excluded. This is not official GitHub billing.
        </div>

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
                sub={data.totals.unpricedModelCount > 0 ? "Excludes unpriced models" : "Priced models"}
              />
              <SummaryCard
                label="Estimated AI credits"
                value={formatAiCredits(data.totals.estimatedAiCredits)}
                sub={data.totals.unpricedModelCount > 0 ? "Excludes unpriced models" : "GitHub credit estimate"}
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
                  Updated {formatDateTime(data.generatedAt)}
                </div>
              </div>

              {isEmpty ? (
                <div className="p-4">
                  <EmptyState
                    message="No persisted local usage yet"
                    sub="This view only includes completed sessions with shutdown summaries and model metrics still available on disk."
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
                        <th className="px-4 py-3 text-right font-medium">AI credits</th>
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
                        <ModelRow key={row.model} row={row} />
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
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">{label}</div>
      <div className="mt-1 text-sm font-medium text-text-primary">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-text-faint">{sub}</div>}
    </div>
  );
}

function CoverageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-warning/20 bg-bg-primary px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">{label}</div>
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
            GitHub public pricing did not include {formatNumber(count)} observed model{count === 1 ? "" : "s"}. These models remain visible below with token totals, but their estimated cost and AI credits are excluded from summary totals.
          </p>
        </div>
      </div>

      <div className="grid gap-2 text-xs text-text-muted md:grid-cols-2 xl:grid-cols-4">
        <CoverageStat label="Unpriced tokens" value={formatNumber(unpricedTokens.totalTokens)} />
        <CoverageStat label="Unpriced requests" value={formatNumber(unpricedTokens.requests)} />
        <CoverageStat label="Unpriced models" value={formatNumber(count)} />
        <CoverageStat label="Excluded cost" value={formatCurrencyUsd(0)} />
      </div>

      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.map((row) => (
            <span
              key={row.model}
              className="rounded-full border border-warning/20 bg-bg-primary px-2 py-0.5 text-[11px] font-medium text-text-secondary"
            >
              {row.model}
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
      <td className="px-4 py-3 font-medium text-text-primary">{row.model}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.sessions)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.requests)}</td>
      <td className="px-4 py-3 text-right font-medium text-text-primary">{formatCurrencyUsd(row.estimatedCostUsd)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatAiCredits(row.estimatedAiCredits)}</td>
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

function formatCoverageWindow(coverage: CopilotUsageCoverage): string {
  if (!coverage.earliestIncludedAt || !coverage.latestIncludedAt) {
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
