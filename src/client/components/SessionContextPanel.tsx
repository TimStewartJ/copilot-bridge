import type {
  SessionContextCapabilities,
  SessionContextEvent,
  SessionContextResponse,
  SessionContextSummary,
} from "../../shared/session-context.js";
import { Gauge } from "lucide-react";
import {
  type ChatTurnPreviews,
  CapabilityPill,
  ContextMeter,
  formatTokenValue,
  getSummaryMetrics,
  getTurnId,
  MetricChip,
  optionalNumber,
  sumOptionalNumbers,
} from "./SessionContextHelpers";
import SessionContextGraph from "./SessionContextGraph";

export default function SessionContextPanel({
  capabilities,
  context,
  error,
  loading,
  previews,
  summary,
}: {
  capabilities?: SessionContextCapabilities;
  context?: SessionContextResponse | null;
  error?: string | null;
  loading?: boolean;
  previews: ChatTurnPreviews;
  summary?: SessionContextSummary | null;
}) {
  const metrics = getSummaryMetrics(summary);
  const inputTokens = optionalNumber(summary?.modelUsage?.inputTokens);
  const outputTokens = optionalNumber(summary?.modelUsage?.outputTokens);
  const cachedTokens = sumOptionalNumbers(summary?.modelUsage?.cacheReadTokens, summary?.modelUsage?.cacheWriteTokens);
  const reasoningTokens = optionalNumber(summary?.modelUsage?.reasoningTokens);
  const requests = optionalNumber(summary?.modelUsage?.requests);
  const model = summary?.currentModel;
  const provider = context?.provider;
  const turns = context?.turns ?? [];
  const events = context?.events ?? [];
  const eventsByTurnId = new Map<string, SessionContextEvent[]>();
  const knownTurnIds = new Set(turns.map((turn) => getTurnId(turn)).filter((turnId): turnId is string => Boolean(turnId)));
  for (const event of events) {
    const turnId = event.bridgeTurnId ?? undefined;
    if (!turnId || !knownTurnIds.has(turnId)) continue;
    const existing = eventsByTurnId.get(turnId) ?? [];
    existing.push(event);
    eventsByTurnId.set(turnId, existing);
  }

  return (
    <section className="space-y-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-text-primary">
          <Gauge size={12} /> Context
        </span>
        {model && <span className="truncate text-[11px] text-text-muted" title={model}>{model}</span>}
        {metrics.remaining !== undefined && <span className="ml-auto text-[11px] text-text-muted">{formatTokenValue(metrics.remaining)} left</span>}
      </div>

      {error ? (
        <div role="alert" className="rounded border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          Context unavailable
          <details><summary className="cursor-pointer">Details</summary>{error}</details>
        </div>
      ) : (
        <div className="space-y-2">
          <ContextMeter metrics={metrics} />
          {(metrics.used === undefined || metrics.limit === undefined) && (
            <p className="text-xs text-text-muted">
              {metrics.used !== undefined ? `${formatTokenValue(metrics.used)} used · Window size unavailable` : loading ? "Loading usage..." : "Context usage unavailable"}
            </p>
          )}
          <SessionContextGraph
            capabilities={capabilities}
            events={events}
            eventsByTurnId={eventsByTurnId}
            previews={previews}
            turns={turns}
          />
          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer hover:text-text-primary">Usage details</summary>
            <div className="mt-2 flex flex-wrap gap-1">
              <MetricChip label="input" value={inputTokens} />
              <MetricChip label="output" value={outputTokens} />
              <MetricChip label="cached" value={cachedTokens} />
              <MetricChip label="reasoning" value={reasoningTokens} />
              <MetricChip label="requests" value={requests} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {provider && <span>{provider}</span>}
              <CapabilityPill label="window" value={capabilities?.contextWindow} />
              <CapabilityPill label="usage" value={capabilities?.modelUsage} />
              <CapabilityPill label="compaction" value={capabilities?.compaction} />
              <CapabilityPill label="truncation" value={capabilities?.truncation} />
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
