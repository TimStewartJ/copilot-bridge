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
    () => (data ? formatSkipReasonSummary(data.coverage) : "No scan yet."),
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
        Usage saved on this device. Estimates, not official billing.
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
              Checked {formatNumber(data.index.sessionsProcessed)} of {formatNumber(data.index.sessionsTotal)} sessions.
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
                No price card for {formatNumber(data.totals.unpricedModelCount)} model{data.totals.unpricedModelCount === 1 ? "" : "s"}; the estimate leaves them out.
              </Notice>
            )}

            <Section
              label="Per-model totals"
              action={<span className={DS.usage.meta}>Updated {formatDateTime(data.index.completedAt ?? data.generatedAt)}</span>}
            >
              {isEmpty ? (
                <EmptyHint>
                  {isRanged ? "No local usage in this window." : "No local usage yet."}
                </EmptyHint>
              ) : <UsageModelList models={data.models} />}
            </Section>

            <div className="space-y-2">
              <Details label="Coverage and exclusions" detail={`${formatNumber(data.coverage.sessionsSkipped)} skipped`}>
                <p className={cx(DS.usage.prose, "mb-3")}>
                  Work since a session's last shutdown is not counted.
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
                    Kept for {formatNumber(data.deferWorkers.retentionDays)} days. Included in the totals above.
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
    return "None skipped.";
  }

  return `Skipped: ${reasons.join(" · ")}.`;
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
