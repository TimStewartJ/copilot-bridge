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
    <section className="rounded-lg border border-border bg-bg/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-text-primary">
          <Gauge size={12} /> Context
        </span>
        {provider && <span className="text-[11px] text-text-muted">{provider}</span>}
        {model && <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-text-muted">{model}</span>}
        <div className="flex flex-wrap gap-1">
          <CapabilityPill label="window" value={capabilities?.contextWindow} />
          <CapabilityPill label="usage" value={capabilities?.modelUsage} />
          <CapabilityPill label="compaction" value={capabilities?.compaction} />
          <CapabilityPill label="truncation" value={capabilities?.truncation} />
        </div>
      </div>

      {error ? (
        <div className="rounded border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          Context details unavailable. Chat remains usable.
        </div>
      ) : (
        <div className="space-y-3">
          <ContextMeter metrics={metrics} />
          <div className="flex flex-wrap gap-1">
            <MetricChip label="total" value={metrics.used} />
            <MetricChip label="input" value={inputTokens} />
            <MetricChip label="output" value={outputTokens} />
            <MetricChip label="cached" value={cachedTokens} />
            <MetricChip label="reasoning" value={reasoningTokens} />
            <MetricChip label="remaining" value={metrics.remaining} />
            <MetricChip label="requests" value={requests} />
          </div>
          {metrics.used === undefined && !loading && capabilities?.modelUsage === "unavailable" && (
            <p className="text-xs text-text-muted">Model usage is unavailable for this provider.</p>
          )}
          {metrics.limit === undefined && !loading && capabilities?.contextWindow === "unavailable" && (
            <p className="text-xs text-text-muted">Context window size is unavailable for this provider.</p>
          )}
          {metrics.used === undefined && loading && (
            <p className="text-xs text-text-muted">Waiting for usage from the provider…</p>
          )}
          {metrics.used === undefined && !loading && capabilities?.modelUsage !== "unavailable" && (
            <p className="text-xs text-text-muted">Waiting for usage from the provider…</p>
          )}
          <SessionContextGraph
            capabilities={capabilities}
            events={events}
            eventsByTurnId={eventsByTurnId}
            previews={previews}
            turns={turns}
          />
        </div>
      )}
    </section>
  );
}
