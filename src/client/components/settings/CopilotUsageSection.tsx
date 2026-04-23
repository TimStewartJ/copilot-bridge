import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Loader2, RotateCw } from "lucide-react";
import type { CopilotUsageCoverage, CopilotUsageModelRow, CopilotUsageSkipReason } from "../../api";
import { useCopilotUsageQuery } from "../../hooks/queries/useCopilotUsage";
import EmptyState from "../shared/EmptyState";
import { SettingsSection } from "./SettingsSection";

const NUMBER_FORMATTER = new Intl.NumberFormat();
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
      description="Estimated from local session history on this device. Not official GitHub, billing, or cross-device usage."
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
          Local estimate only. Only persisted shutdown summaries count toward totals; active work after the latest persisted shutdown is excluded.
        </div>

        {isLoading && !data && (
          <div className="rounded-md border border-border bg-bg-elevated p-4">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 size={15} className="animate-spin" />
              Scanning local Copilot session history…
            </div>
          </div>
        )}

        {!isLoading && !data && error && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-3 text-sm text-error">
            Failed to load local Copilot usage: {formatError(error)}
          </div>
        )}

        {data && (
          <>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <SummaryCard label="Total tokens" value={formatNumber(data.totals.totalTokens)} />
              <SummaryCard label="Requests" value={formatNumber(data.totals.requests)} />
              <SummaryCard label="Included sessions" value={formatNumber(data.coverage.sessionsIncluded)} />
              <SummaryCard label="Coverage window" value={formatCoverageWindow(data.coverage)} />
            </div>

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

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-elevated px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">{label}</div>
      <div className="mt-1 text-sm font-medium text-text-primary">{value}</div>
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

function ModelRow({ row }: { row: CopilotUsageModelRow }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-4 py-3 font-medium text-text-primary">{row.model}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.sessions)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.requests)}</td>
      <td className="px-4 py-3 text-right font-medium text-text-primary">{formatNumber(row.totalTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.inputTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.outputTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.cacheReadTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.cacheWriteTokens)}</td>
      <td className="px-4 py-3 text-right text-text-muted">{formatNumber(row.reasoningTokens)}</td>
    </tr>
  );
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
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
