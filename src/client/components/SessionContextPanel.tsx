import type {
  SessionContextCapabilities,
  SessionContextSummary,
} from "../../shared/session-context.js";
import { AlertTriangle, Gauge } from "lucide-react";
import { Details, Notice } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import TokenBreakdown from "./usage/TokenBreakdown";
import {
  CapabilityPill,
  ContextMeter,
  formatTokenValue,
  getSummaryMetrics,
  optionalNumber,
} from "./SessionContextHelpers";

export default function SessionContextPanel({
  capabilities,
  provider,
  error,
  loading,
  summary,
}: {
  capabilities?: SessionContextCapabilities;
  provider?: string;
  error?: string | null;
  loading?: boolean;
  summary?: SessionContextSummary | null;
}) {
  const metrics = getSummaryMetrics(summary);
  const inputTokens = optionalNumber(summary?.modelUsage?.inputTokens);
  const outputTokens = optionalNumber(summary?.modelUsage?.outputTokens);
  const cacheReadTokens = optionalNumber(summary?.modelUsage?.cacheReadTokens);
  const cacheWriteTokens = optionalNumber(summary?.modelUsage?.cacheWriteTokens);
  const reasoningTokens = optionalNumber(summary?.modelUsage?.reasoningTokens);
  const requests = optionalNumber(summary?.modelUsage?.requests);
  const model = summary?.currentModel;

  return (
    <section className="space-y-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-text-primary">
          <Gauge size={12} /> Context
        </span>
        {model && <span className="truncate text-[11px] text-text-secondary" title={model}>{model}</span>}
        {metrics.remaining !== undefined && <span className="ml-auto text-[11px] text-text-secondary">{formatTokenValue(metrics.remaining)} left</span>}
      </div>

      {error ? (
        <Notice tone="warning" role="alert" icon={<AlertTriangle size={14} />} title="Context unavailable">
          <details><summary className="cursor-pointer">Details</summary>{error}</details>
        </Notice>
      ) : (
        <div className="space-y-2">
          <ContextMeter metrics={metrics} />
          {(metrics.used === undefined || metrics.limit === undefined) && (
            <p className="text-xs text-text-secondary">
              {metrics.used !== undefined ? `${formatTokenValue(metrics.used)} used · Window size unavailable` : loading ? "Loading usage..." : "Context usage unavailable"}
            </p>
          )}
          <Details label="Usage details">
            <TokenBreakdown totals={{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, requests }} />
            <p className={cx(DS.usage.prose, "mt-2")}>
              These are SDK-reported session counters; context occupancy above is not the cumulative token total.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {provider && <span className={DS.usage.meta}>{provider}</span>}
              <CapabilityPill label="window" value={capabilities?.contextWindow} />
              <CapabilityPill label="usage" value={capabilities?.modelUsage} />
              <CapabilityPill label="compaction" value={capabilities?.compaction} />
              <CapabilityPill label="truncation" value={capabilities?.truncation} />
            </div>
          </Details>
        </div>
      )}
    </section>
  );
}
