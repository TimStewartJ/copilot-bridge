import type {
  SessionContextCapabilities,
  SessionContextEvent,
  SessionContextTurn,
} from "../../shared/session-context.js";
import { useState } from "react";
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
  getSummaryMetrics,
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

export function buildTurnGraphPoints(
  turns: SessionContextTurn[],
  eventsByTurnId: Map<string, SessionContextEvent[]>,
  previews: ChatTurnPreviews,
): TurnGraphPoint[] {
  return turns.map((turn, index) => {
    const turnId = getTurnId(turn);
    const turnEvents = turnId ? eventsByTurnId.get(turnId) ?? [] : [];
    const latestEvent = turnEvents
      .filter((event) => event.type === "context_snapshot" && (
        (optionalNumber(event.tokensUsed) !== undefined && event.tokensUsed! >= 0)
        || (optionalNumber(event.usageRatio) !== undefined && event.usageRatio! >= 0)
      ))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id)
      .at(-1);
    const turnIndex = (turn.turnNumber ?? getTurnNumber(index)) - 1;
    return {
      turn,
      index: turnIndex,
      label: `T${getTurnNumber(turnIndex)}`,
      preview: getTurnPreview(turn, turnIndex, previews),
      event: latestEvent,
      percent: getSummaryMetrics(latestEvent).percent,
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
  totalTurns,
}: {
  capabilities?: SessionContextCapabilities;
  events: SessionContextEvent[];
  eventsByTurnId: Map<string, SessionContextEvent[]>;
  previews: ChatTurnPreviews;
  turns: SessionContextTurn[];
  totalTurns?: number;
}) {
  const [selectedTurnId, setSelectedTurnId] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const points = buildTurnGraphPoints(turns, eventsByTurnId, previews);
  const visiblePoints = showAll ? points : points.slice(-30);
  const selected = visiblePoints.find((point) => point.turn.bridgeTurnId === selectedTurnId) ?? visiblePoints.at(-1);
  const markers = events.filter((event) => event.type !== "context_snapshot" || !event.bridgeTurnId || !eventsByTurnId.has(event.bridgeTurnId));
  const useTokens = visiblePoints.some((point) => point.tokens !== undefined);
  const valueOf = (point: TurnGraphPoint) => useTokens ? point.tokens : point.percent;
  const maxValue = useTokens ? Math.max(1, ...visiblePoints.map((point) => point.tokens ?? 0)) : 100;
  const plotted = visiblePoints.map((point, index) => ({
    ...point,
    x: 48 + (index / Math.max(1, visiblePoints.length - 1)) * 536,
    y: valueOf(point) === undefined ? undefined : 100 - Math.max(0, valueOf(point)!) / maxValue * 88,
  }));
  let previousKnown = false;
  const path = plotted.map((point) => {
    if (point.y === undefined) {
      previousKnown = false;
      return "";
    }
    const command = previousKnown ? "L" : "M";
    previousKnown = true;
    return `${command}${point.x},${point.y}`;
  }).join(" ");
  const hasValues = plotted.some((point) => point.y !== undefined);
  const pointTitle = (point: TurnGraphPoint) => [
    `Turn ${getTurnNumber(point.index)}`,
    point.tokens !== undefined ? formatTokenValue(point.tokens) : undefined,
    point.percent !== undefined ? formatPercent(point.percent) : undefined,
    valueOf(point) === undefined ? "Usage unavailable" : undefined,
    provenanceLabel(point.event?.provenance?.tokensUsed),
    point.preview?.preview,
  ].filter(Boolean).join(" · ");

  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
        <span>Context history</span>
        {points.length > 30 && (
          <select aria-label="History range" value={showAll ? "all" : "recent"} onChange={(event) => setShowAll(event.target.value === "all")} className="rounded bg-bg-secondary px-1 py-0.5">
            <option value="recent">Last 30 turns</option>
            <option value="all">{points.length} loaded turns</option>
          </select>
        )}
      </div>
      {totalTurns !== undefined && totalTurns > points.length && (
        <p className="mt-1 text-[11px] text-text-muted">
          Latest {points.length} of {totalTurns} turns
        </p>
      )}
      {hasValues ? (
        <svg viewBox="0 0 600 120" className="mt-1 w-full h-28" role="group" aria-label={`Context usage line graph, ${visiblePoints.length} turns, ${useTokens ? "tokens" : "percent"}`}>
          {[12, 56, 100].map((y, index) => (
            <g key={y}>
              <line x1="48" x2="584" y1={y} y2={y} className="stroke-border" strokeDasharray="3 4" />
              <text x="42" y={y + 3} textAnchor="end" className="fill-text-muted text-[9px]">
                {useTokens ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(maxValue * (1 - index / 2)) : `${100 - index * 50}%`}
              </text>
            </g>
          ))}
          <path d={path} fill="none" className="stroke-accent" strokeWidth="2" strokeLinejoin="round" />
          {plotted.filter((point) => point.y !== undefined).map((point) => (
            <circle
              key={point.turn.bridgeTurnId}
              cx={point.x}
              cy={point.y}
              r={point.turn.bridgeTurnId === selected?.turn.bridgeTurnId ? 5 : 3}
              className={`cursor-pointer stroke-bg focus:stroke-text-primary ${point.percent !== undefined && point.percent >= 90 ? "fill-error" : point.percent !== undefined && point.percent >= 75 ? "fill-warning" : "fill-accent"}`}
              strokeWidth="2"
              role="button"
              tabIndex={0}
              aria-label={pointTitle(point)}
              aria-pressed={point.turn.bridgeTurnId === selected?.turn.bridgeTurnId}
              onClick={() => setSelectedTurnId(point.turn.bridgeTurnId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedTurnId(point.turn.bridgeTurnId);
                }
              }}
            ><title>{pointTitle(point)}</title></circle>
          ))}
          <text x="48" y="116" className="fill-text-muted text-[9px]">{visiblePoints[0]?.label}</text>
          {visiblePoints.length > 1 && <text x="584" y="116" textAnchor="end" className="fill-text-muted text-[9px]">{visiblePoints.at(-1)?.label}</text>}
        </svg>
      ) : <p className="py-2 text-xs text-text-muted">No context history yet</p>}
      {selected && (
        <div className="space-y-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Inspect turn" value={selected.turn.bridgeTurnId} onChange={(event) => setSelectedTurnId(event.target.value)} className="rounded bg-bg-secondary px-1 py-0.5 text-text-primary">
              {visiblePoints.map((point) => <option key={point.turn.bridgeTurnId} value={point.turn.bridgeTurnId}>Turn {getTurnNumber(point.index)}</option>)}
            </select>
            <span className="text-text-muted">
              {selected.tokens !== undefined ? formatTokenValue(selected.tokens) : "Tokens unavailable"}
              {selected.percent !== undefined && ` · ${formatPercent(selected.percent)}`}
            </span>
            {capabilities?.contextWindow && <ProvenanceChip provenance={selected.event?.provenance?.tokensUsed} />}
          </div>
          {selected.preview && <p className="truncate text-text-muted" title={selected.preview.preview}>{selected.preview.preview}</p>}
        </div>
      )}
      {markers.length > 0 && (
        <details className="mt-2 text-[11px] text-text-muted">
          <summary className="cursor-pointer">Events ({markers.length})</summary>
          <ul className="mt-1 space-y-1">
            {markers.map((event) => (
              <li key={event.id}>
                <span className="text-warning">{eventTitle(event)}</span>
                {event.bridgeTurnId && ` · ${points.find((point) => point.turn.bridgeTurnId === event.bridgeTurnId)?.label ?? "Session"}`}
                {eventUsageText(event) && ` · ${eventUsageText(event)}`}
              </li>
            ))}
          </ul>
        </details>
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
