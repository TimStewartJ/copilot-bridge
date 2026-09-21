import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import type { CopilotUsageCoverage, CopilotUsageSkipReason } from "../../api";
import {
  COPILOT_USAGE_RANGE_DESCRIPTIONS,
  COPILOT_USAGE_RANGE_KEYS,
  COPILOT_USAGE_RANGE_LABELS,
  DEFAULT_COPILOT_USAGE_RANGE,
  type CopilotUsageRangeKey,
} from "../../../shared/copilot-usage-range";
import { useCopilotUsageQuery } from "../../hooks/queries/useCopilotUsage";
import { DS, cx } from "../../design/tokens";
import { Badge, Button, Details, EmptyHint, Notice, Section, SegmentedControl, StatRow } from "../../design/primitives";
import { describeMeteredCoverage, formatUsageCredits, formatUsageNumber as formatNumber, formatUsageUsd, hasMeteredUsage, meteredCostUsd } from "../../lib/usage-presentation";
import UsageModelList from "../usage/UsageModelList";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "../shared/Skeleton";

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

export function CopilotUsageSection() {
  const [range, setRange] = useState<CopilotUsageRangeKey>(DEFAULT_COPILOT_USAGE_RANGE);
  const { data, error, isLoading, refresh } = useCopilotUsageQuery({ includeSessions: false, range });
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

  const indexing = data?.index.state === "scanning";
  const busy = refreshing || indexing || (isLoading && !data);
  const isEmpty = Boolean(data && data.models.length === 0 && data.coverage.sessionsIncluded === 0);
  const isRanged = Boolean(data?.range.startAt);
  const meteredCost = data ? meteredCostUsd(data.totals) : null;
  const reasonSummary = useMemo(
    () => (data ? formatSkipReasonSummary(data.coverage) : "Skipped session details will appear after the first successful scan."),
    [data],
  );

  return (
    <Section
      level="page"
      label="Local Copilot usage"
      action={(
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleRefresh()}
          disabled={busy}
          icon={busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
        >
          Refresh
        </Button>
      )}
    >
      <p className={cx(DS.usage.prose, "mb-5")}>
        Saved usage on this device, including retained deferred workers. Estimates and SDK-reported metering are not official billing.
      </p>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            ariaLabel="Usage time range"
            size="sm"
            value={range}
            onChange={setRange}
            className="max-w-full flex-wrap"
            options={COPILOT_USAGE_RANGE_KEYS.map((key) => ({
              value: key,
              label: COPILOT_USAGE_RANGE_LABELS[key],
              title: COPILOT_USAGE_RANGE_DESCRIPTIONS[key],
            }))}
          />
          <span className={DS.usage.meta}>
            {data ? formatRangeWindow(data.range.startAt) : COPILOT_USAGE_RANGE_DESCRIPTIONS[range]}
          </span>
        </div>

        {data && indexing && (
          <div role="status" className="text-xs leading-relaxed text-text-muted">
            <span className={DS.motion.live}>Indexing local usage in the background</span>
            <p className="mt-1 tabular-nums">
              Checked {formatNumber(data.index.sessionsProcessed)} of {formatNumber(data.index.sessionsTotal)} sessions. Totals update as the scan progresses.
            </p>
          </div>
        )}
        {data?.index.state === "error" && (
          <Notice tone="danger" icon={<AlertTriangle size={14} />}>
            {data.index.error ?? "Local usage indexing failed. Previously cached totals are still shown."}
          </Notice>
        )}
        {data?.index.warning && (
          <Notice tone="warning" icon={<AlertTriangle size={14} />}>{data.index.warning}</Notice>
        )}
        {isLoading && !data && (
          <LoadingSkeletonRegion isLoading label="Scanning local Copilot session history" className="space-y-5">
            <p className={DS.usage.prose}>Scanning local Copilot session history…</p>
            <div className="flex flex-wrap gap-x-8 gap-y-4">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton height={18} width={84} shape="pill" />
                  <Skeleton height={10} width={64} shape="pill" />
                </div>
              ))}
            </div>
            <SkeletonText lines={3} widths={["100%", "82%", "64%"]} />
          </LoadingSkeletonRegion>
        )}
        {!isLoading && !data && error && (
          <Notice tone="danger" icon={<AlertTriangle size={14} />}>
            Failed to load local Copilot usage: {formatError(error)}
          </Notice>
        )}

        {data && (
          <>
            <div className="space-y-4">
              <StatRow stats={[
                {
                  label: "Estimated cost",
                  value: formatUsageUsd(data.totals.estimatedCostUsd),
                  detail: `${formatUsageCredits(data.totals.estimatedAiCredits)} AI credits${data.totals.unpricedModelCount > 0 ? " · excludes unpriced" : ""}`,
                },
                {
                  label: "Metered cost",
                  value: formatUsageUsd(meteredCost),
                  detail: meteredCost !== null ? `SDK-reported · ${describeMeteredCoverage(data.totals)}` : "No GitHub metering in this range",
                },
              ]} />
              <StatRow stats={[
                { label: "Total tokens", value: formatNumber(data.totals.totalTokens) },
                { label: "Requests", value: formatNumber(data.totals.requests) },
                { label: "Included sessions", value: formatNumber(data.coverage.sessionsIncluded) },
              ]} />
            </div>
            <p className={DS.usage.meta}>Coverage window: {formatCoverageWindow(data.coverage)}</p>

            {data.totals.unpricedModelCount > 0 && (
              <Notice tone="warning" icon={<AlertTriangle size={14} />} title="Unknown pricing excluded from cost totals">
                No usable price card is available for {formatNumber(data.totals.unpricedModelCount)} observed model{data.totals.unpricedModelCount === 1 ? "" : "s"}.
                Their tokens remain in the totals; their cost is not included in the estimate. Expand a model below for its pricing and metering.
              </Notice>
            )}

            <Section
              label="Per-model totals"
              action={<span className={DS.usage.meta}>Updated {formatDateTime(data.index.completedAt ?? data.generatedAt)}</span>}
            >
              <p className={cx(DS.usage.prose, "mb-2")}>
                Open a model for token and pricing details. Session counts are per model and may overlap.
              </p>
              {isEmpty ? (
                <EmptyHint>
                  {isRanged ? "No local usage in this window. Pick a wider range, or wait for a shutdown summary."
                    : "No persisted local usage yet. Completed sessions with shutdown summaries appear here."}
                </EmptyHint>
              ) : <UsageModelList models={data.models} />}
            </Section>

            <div className="space-y-2">
              <Details label="Coverage and exclusions" detail={`${formatNumber(data.coverage.sessionsSkipped)} skipped`}>
                <p className={cx(DS.usage.prose, "mb-3")}>
                  Included sessions come from shutdown summaries still present on disk plus retained disposable defer-worker summaries. Resumed sessions keep their earlier persisted shutdown usage, but active work after the latest shutdown is still excluded.
                  {isRanged && " Counts are limited to sessions with recorded usage inside the selected window."}
                </p>
                <StatRow stats={[
                  { label: "Sessions seen", value: formatNumber(data.coverage.sessionsSeen) },
                  { label: "Events files found", value: formatNumber(data.coverage.sessionsWithEvents) },
                  { label: "Included", value: formatNumber(data.coverage.sessionsIncluded) },
                  { label: "Skipped", value: formatNumber(data.coverage.sessionsSkipped) },
                ]} />
                <p className={cx(DS.usage.prose, "mt-3")}>{reasonSummary}</p>
                {data.totals.unpricedModelCount > 0 && (
                  <div className="mt-4 space-y-2">
                    <StatRow stats={[
                      { label: "Unpriced tokens", value: formatNumber(data.totals.unpricedTokens.totalTokens) },
                      { label: "Unpriced requests", value: formatNumber(data.totals.unpricedTokens.requests) },
                      { label: "Unpriced models", value: formatNumber(data.totals.unpricedModelCount) },
                      { label: "Excluded metered cost", value: formatUsageUsd(meteredCostUsd(data.totals.unpricedTokens)) },
                    ]} />
                    <div className="flex flex-wrap gap-1">
                      {data.unpricedModels.map((row) => (
                        <Badge key={`${row.model}:${row.contextTier ?? "default"}`} tone="neutral">
                          {row.model}{row.contextTierLabel ? ` · ${row.contextTierLabel}` : ""}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </Details>

              {data.deferWorkers.capturedRuns > 0 && (
                <Details label="Deferred workers" detail={`${formatNumber(data.deferWorkers.capturedRuns)} captured runs`}>
                  <p className={cx(DS.usage.prose, "mb-3")}>
                    Captured at worker shutdown and retained for {formatNumber(data.deferWorkers.retentionDays)} days after disposable session cleanup. These readings are included in the totals above.
                  </p>
                  <StatRow stats={[
                    { label: "Captured runs", value: formatNumber(data.deferWorkers.capturedRuns) },
                    { label: "Parent sessions", value: formatNumber(data.deferWorkers.parentSessions) },
                    { label: "Metered cost", value: formatUsageUsd(meteredCostUsd(data.deferWorkers)) },
                    { label: "Metered credits", value: hasMeteredUsage(data.deferWorkers) ? formatUsageCredits(data.deferWorkers.meteredAiCredits) : "Not recorded" },
                    { label: "Total tokens", value: formatNumber(data.deferWorkers.totalTokens) },
                  ]} />
                </Details>
              )}
              <Details label="How this is counted">
                <p className={DS.usage.prose}>
                  Metered cost is SDK-reported usage saved at shutdown, not an invoice, and only covers logs that carry metering. Cost not assigned to a named model appears as Unattributed.
                  Estimated cost uses the configured Copilot price card: uncached input, cache reads, cache writes and output are priced separately. Cache writes use 1.25x the input rate; reasoning tokens are already included in output.
                  Active work before shutdown, unpersisted sessions and other devices are excluded.
                </p>
              </Details>
            </div>
          </>
        )}

        {data && (refreshError || error) && (
          <Notice tone="danger" icon={<AlertTriangle size={14} />}>
            Last refresh failed: {refreshError ?? formatError(error)}. The previous reading is still shown.
          </Notice>
        )}
      </div>
    </Section>
  );
}

function formatRangeWindow(startAt: string | null): string {
  if (!startAt) return "All local history";
  const start = formatDate(startAt);
  return start ? `Since ${start}` : "Range date unavailable";
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
