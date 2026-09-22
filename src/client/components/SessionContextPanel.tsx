import { useEffect, useState } from "react";
import type {
  SessionContextCapabilities,
  SessionContextInsights,
  SessionContextSummary,
} from "../../shared/session-context.js";
import type { SessionUsageMetrics } from "../api";
import { AlertTriangle } from "lucide-react";
import { Details, EmptyHint, Field, FieldList, Notice, Section } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import TokenBreakdown from "./usage/TokenBreakdown";
import { formatDuration } from "../lib/tool-presentation";
import {
  BLOCKING_PERCENT,
  COMPACTION_PERCENT,
  ContextMeter,
  MeterLegend,
  describeCacheExpiry,
  formatCompactTokens,
  formatNumber,
  formatPercent,
  formatTokenValue,
  getContextPressure,
  getMeterSegments,
  getSummaryMetrics,
  optionalNumber,
} from "./SessionContextHelpers";

export interface SessionCostReading {
  label: string;
  error?: string;
  hasPrevious?: boolean;
}

/** Re-render on a slow clock so "warm for 3 more min" keeps telling the truth while the panel is open. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function plural(count: number, word: string): string {
  return `${formatNumber(count)} ${word}${count === 1 ? "" : "s"}`;
}

export default function SessionContextPanel({
  error,
  loading,
  summary,
  insights,
  usage,
  cost,
}: {
  capabilities?: SessionContextCapabilities;
  provider?: string;
  error?: string | null;
  loading?: boolean;
  summary?: SessionContextSummary | null;
  insights?: SessionContextInsights | null;
  usage?: SessionUsageMetrics | null;
  cost?: SessionCostReading;
}) {
  const now = useNow(15_000);
  const metrics = getSummaryMetrics(summary);
  const hasWindow = metrics.used !== undefined && metrics.limit !== undefined;
  const lastCompaction = insights?.lastCompaction ?? null;
  const live = usage?.contextInfo;
  // A split taken before the last compaction describes a window that no longer exists.
  const recorded = insights?.breakdown
    && (!lastCompaction || Date.parse(insights.breakdown.observedAt) >= Date.parse(lastCompaction.occurredAt))
    ? insights.breakdown
    : null;
  const breakdown = live
    ? { systemTokens: live.systemTokens, toolDefinitionsTokens: live.toolDefinitionsTokens }
    : recorded;
  const compactionPercent = live?.compactionThreshold && live.promptTokenLimit
    ? Math.min(100, (live.compactionThreshold / live.promptTokenLimit) * 100)
    : COMPACTION_PERCENT;
  const pressure = getContextPressure(metrics.percent, compactionPercent);
  const segments = getMeterSegments(metrics, breakdown, pressure);
  const compactionCount = summary?.compactionCount ?? 0;

  const sessionTokens = usage?.tokens;
  const lastCall = summary?.modelUsage;
  const cacheSource = sessionTokens ?? (lastCall ? {
    inputTokens: optionalNumber(lastCall.inputTokens) ?? 0,
    cacheReadTokens: optionalNumber(lastCall.cacheReadTokens) ?? 0,
  } : undefined);
  const cacheShare = cacheSource && cacheSource.inputTokens > 0
    ? Math.min(100, (cacheSource.cacheReadTokens / cacheSource.inputTokens) * 100)
    : undefined;
  const cacheExpiry = describeCacheExpiry(insights?.cacheExpiresAt, now);
  const codeChanges = usage?.codeChanges;

  return (
    <div className="@container">
      <div className="grid gap-x-10 gap-y-5 @[40rem]:grid-cols-2">
        <Section
          label="Context window"
          count={hasWindow ? (
            <span title={`${formatTokenValue(metrics.used!)} of ${formatTokenValue(metrics.limit!)}`}>
              {formatCompactTokens(metrics.used!)} of {formatCompactTokens(metrics.limit!)}
            </span>
          ) : undefined}
          action={metrics.percent !== undefined ? (
            <span className={cx("text-xs tabular-nums", pressure === "room" ? "text-text-secondary" : pressure === "compacting" ? DS.tone.warning : DS.tone.danger)}>
              {formatPercent(metrics.percent)} full
            </span>
          ) : undefined}
        >
          {error ? (
            <Notice tone="warning" role="alert" icon={<AlertTriangle size={14} />} title="Context unavailable">
              <details><summary className="cursor-pointer">Details</summary>{error}</details>
            </Notice>
          ) : !hasWindow ? (
            <EmptyHint>
              {metrics.used !== undefined
                ? `${formatTokenValue(metrics.used)} in use. The model did not report its window size.`
                : loading ? "Loading usage..." : "Context usage unavailable. It appears after the next reply."}
            </EmptyHint>
          ) : (
            <div className="space-y-2.5">
              <ContextMeter metrics={metrics} segments={segments} compactionPercent={compactionPercent} />
              <MeterLegend segments={segments} mcpToolsTokens={live?.mcpToolsTokens} />
              <p className={DS.usage.prose}>
                {pressure === "room" && (
                  <>
                    Compacts automatically at {formatPercent(compactionPercent)}, in about{" "}
                    {formatCompactTokens(Math.max(0, metrics.limit! * compactionPercent / 100 - metrics.used!))} tokens.
                  </>
                )}
                {pressure === "compacting" && (
                  <span className={DS.tone.warning}>
                    Past {formatPercent(compactionPercent)}: older turns are being summarised in the background.
                    The session pauses at {formatPercent(BLOCKING_PERCENT)} if that has not finished.
                  </span>
                )}
                {pressure === "blocking" && (
                  <span className={DS.tone.danger}>
                    Nearly full. The next turn waits for compaction to finish.
                  </span>
                )}
              </p>
              <p className={DS.usage.prose}>
                {compactionCount === 0
                  ? "Not compacted yet."
                  : `Compacted ${compactionCount === 1 ? "once" : `${formatNumber(compactionCount)} times`}.`}
              </p>
            </div>
          )}
        </Section>

        <Section label="This session">
          <FieldList className="-mt-1">
            {cost && (
              <Field label="Cost">
                <span className="tabular-nums" title="Reported by the Copilot SDK for this session; not an invoice">{cost.label}</span>
              </Field>
            )}
            {usage?.modelRequests !== undefined && usage.modelRequests > 0 && (
              <Field label="Model calls">
                <span className="tabular-nums">{formatNumber(usage.modelRequests)}</span>
                {/* The SDK restarts this count when a session is resumed, so a zero is not "no messages". */}
                {!!usage.totalUserRequests && (
                  <span className={cx("ml-2", DS.usage.meta)}>for {plural(usage.totalUserRequests, "message")} since the session was loaded</span>
                )}
              </Field>
            )}
            {(cacheShare !== undefined || cacheExpiry) && (
              <Field label="Prompt cache">
                <span title="Input the model read back from its prompt cache. Cached input is cheaper and faster.">
                  {cacheShare !== undefined && (
                    <span className="tabular-nums">{formatPercent(cacheShare)} of input reused</span>
                  )}
                </span>
                {cacheExpiry && (
                  <span
                    className={cx(cacheShare !== undefined && "ml-2", DS.usage.meta)}
                    title={cacheExpiry.warm ? "Replying before it expires reuses the cached prompt." : "The next reply writes the prompt to the cache again."}
                  >
                    {cacheExpiry.text}
                  </span>
                )}
                {!sessionTokens && cacheShare !== undefined && (
                  <span className={cx("ml-2", DS.usage.meta)}>last model call</span>
                )}
              </Field>
            )}
            {usage?.apiDurationMs !== undefined && usage.apiDurationMs > 0 && (
              <Field label="Model time">
                <span className="tabular-nums">{formatDuration(usage.apiDurationMs)}</span>
              </Field>
            )}
            {codeChanges && (codeChanges.linesAdded > 0 || codeChanges.linesRemoved > 0) && (
              <Field label="Code changes">
                <span className="tabular-nums">+{formatNumber(codeChanges.linesAdded)} −{formatNumber(codeChanges.linesRemoved)}</span>
                <span className={cx("ml-2", DS.usage.meta)}>{plural(codeChanges.filesModified, "file")}</span>
              </Field>
            )}
          </FieldList>
          {cost?.error && (
            <Notice tone="warning" role="alert" icon={<AlertTriangle size={14} />} className="mt-2">
              Cost refresh failed: {cost.error}{cost.hasPrevious ? ". Showing the previous reading." : ""}
            </Notice>
          )}
          {!usage?.available && !cost?.error && (
            <EmptyHint className="mt-1">Session totals appear while the session is loaded.</EmptyHint>
          )}
        </Section>
      </div>

      {(sessionTokens || lastCall) && (
        <Details
          className="mt-4"
          label="Token totals"
          detail={sessionTokens ? "whole session, all models and agents" : "last model call"}
        >
          <TokenBreakdown
            totals={sessionTokens
              ? { ...sessionTokens, requests: usage?.modelRequests }
              : {
                inputTokens: optionalNumber(lastCall?.inputTokens),
                outputTokens: optionalNumber(lastCall?.outputTokens),
                cacheReadTokens: optionalNumber(lastCall?.cacheReadTokens),
                cacheWriteTokens: optionalNumber(lastCall?.cacheWriteTokens),
                reasoningTokens: optionalNumber(lastCall?.reasoningTokens),
                requests: optionalNumber(lastCall?.requests),
              }}
          />
          <p className={cx(DS.usage.prose, "mt-2")}>
            Input counts every token sent to the model, including cached reads; this is not what the window holds now.
          </p>
        </Details>
      )}
    </div>
  );
}
