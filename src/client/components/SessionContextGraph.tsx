import type {
  SessionContextCapabilities,
  SessionContextEvent,
  SessionContextTurn,
} from "../../shared/session-context.js";
import { History } from "lucide-react";
import {
  type ChatTurnPreview,
  type ChatTurnPreviews,
  eventTitle,
  eventUsageText,
  formatNumber,
  formatPercent,
  formatTokenValue,
  getTurnId,
  getTurnNumber,
  getTurnPreview,
  normalizePercent,
  optionalNumber,
  provenanceLabel,
  ProvenanceChip,
} from "./SessionContextHelpers";

interface TurnGraphPoint {
  event?: SessionContextEvent;
  index: number;
  label: string;
  percent?: number;
  preview?: ChatTurnPreview;
  tokens?: number;
  turn: SessionContextTurn;
}

function buildTurnGraphPoints(
  turns: SessionContextTurn[],
  eventsByTurnId: Map<string, SessionContextEvent[]>,
  previews: ChatTurnPreviews,
): TurnGraphPoint[] {
  return turns.map((turn, index) => {
    const turnId = getTurnId(turn);
    const turnEvents = turnId ? eventsByTurnId.get(turnId) ?? [] : [];
    const latestEvent = turnEvents
      .filter((event) => event.type === "context_snapshot")
      .at(-1) ?? turnEvents.at(-1);
    return {
      turn,
      index,
      label: `T${getTurnNumber(index)}`,
      preview: getTurnPreview(turn, index, previews),
      event: latestEvent,
      percent: normalizePercent(latestEvent?.usageRatio),
      tokens: optionalNumber(latestEvent?.tokensUsed),
    };
  });
}

export default function SessionContextGraph({
  capabilities,
  events,
  eventsByTurnId,
  previews,
  turns,
}: {
  capabilities?: SessionContextCapabilities;
  events: SessionContextEvent[];
  eventsByTurnId: Map<string, SessionContextEvent[]>;
  previews: ChatTurnPreviews;
  turns: SessionContextTurn[];
}) {
  const points = buildTurnGraphPoints(turns, eventsByTurnId, previews);
  const unscopedEvents = events.filter((event) => !event.bridgeTurnId || !eventsByTurnId.has(event.bridgeTurnId));
  const maxTokens = Math.max(
    1,
    ...points.map((point) => point.tokens ?? 0),
    ...events.map((event) => event.tokensUsed ?? 0),
  );
  const ariaLabel = points.length > 0
    ? `Context usage graph across ${points.length} turns. Latest ${points.at(-1)?.percent !== undefined ? formatPercent(points.at(-1)!.percent!) : "usage unknown"}.`
    : "Context usage graph unavailable.";

  if (points.length === 0 && events.length === 0) {
    return (
      <div className="rounded border border-border bg-bg-secondary px-3 py-3 text-xs text-text-muted">
        Context graph is unavailable until the provider reports context events.
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="rounded border border-border bg-bg-secondary px-3 py-3">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">Session event markers</div>
        <div className="flex flex-wrap gap-1.5">
          {events.map((event, index) => (
            <span key={index} className="rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning">
              {eventTitle(event)}{eventUsageText(event) ? ` · ${eventUsageText(event)}` : ""}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          <History size={11} /> Context graph
        </div>
        {capabilities?.contextWindow && <ProvenanceChip provenance={points.at(-1)?.event?.provenance?.tokensUsed} />}
      </div>
      <div role="img" aria-label={ariaLabel} className="overflow-x-auto pb-1">
        <div
          className="grid min-w-full items-end gap-1.5"
          style={{ gridTemplateColumns: `repeat(${points.length}, minmax(34px, 1fr))` }}
        >
          {points.map((point) => {
            const height = Math.max(10, Math.round(((point.tokens ?? 0) / maxTokens) * 72));
            const percent = point.percent;
            const tone = percent !== undefined && percent >= 90
              ? "bg-error"
              : percent !== undefined && percent >= 75
                ? "bg-warning"
                : "bg-accent";
            const title = [
              `Turn ${getTurnNumber(point.index)}`,
              point.preview?.preview,
              point.tokens !== undefined ? formatTokenValue(point.tokens) : "usage unavailable",
              percent !== undefined ? formatPercent(percent) : undefined,
              provenanceLabel(point.event?.provenance?.tokensUsed),
            ].filter(Boolean).join(" · ");
            return (
              <button
                key={point.turn.bridgeTurnId}
                type="button"
                title={title}
                aria-label={title}
                className="group flex min-w-[34px] flex-col items-center gap-1 rounded-md px-1 py-1 text-[10px] text-text-muted outline-none transition-colors hover:bg-bg focus:bg-bg focus:ring-1 focus:ring-accent"
              >
                <span className="flex h-20 w-full items-end justify-center rounded bg-bg/80 px-1">
                  <span
                    className={`w-full max-w-5 rounded-t ${tone} transition-all group-hover:opacity-90`}
                    style={{ height: `${height}px` }}
                  />
                </span>
                <span className="font-medium text-text-primary">{point.label}</span>
                <span>{percent !== undefined ? formatPercent(percent) : "--"}</span>
              </button>
            );
          })}
        </div>
      </div>
      {unscopedEvents.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {unscopedEvents.map((event, index) => (
            <span
              key={index}
              title={eventUsageText(event)}
              className="rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning"
            >
              {eventTitle(event)}
            </span>
          ))}
        </div>
      )}
      <table className="sr-only">
        <caption>Context usage by turn</caption>
        <thead>
          <tr>
            <th>Turn</th>
            <th>Usage</th>
            <th>Tokens</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={`sr-${point.turn.bridgeTurnId}`}>
              <td>{point.label}</td>
              <td>{point.percent !== undefined ? formatPercent(point.percent) : "unavailable"}</td>
              <td>{point.tokens !== undefined ? formatNumber(point.tokens) : "unavailable"}</td>
              <td>{provenanceLabel(point.event?.provenance?.tokensUsed) ?? "unknown"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
