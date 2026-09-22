import type {
  SessionContextBreakdown,
  SessionContextCapabilities,
  SessionContextSummary,
} from "../../shared/session-context.js";
import { SESSION_CONTEXT_COMPACTION_THRESHOLDS } from "../../shared/session-context.js";
import { DS, cx } from "../design/tokens";

export type SummaryMetrics = {
  limit?: number;
  percent?: number;
  remaining?: number;
  used?: number;
};

const NUMBER_FORMATTER = new Intl.NumberFormat();

export const COMPACTION_PERCENT = SESSION_CONTEXT_COMPACTION_THRESHOLDS.background * 100;
export const BLOCKING_PERCENT = SESSION_CONTEXT_COMPACTION_THRESHOLDS.blocking * 100;

export function optionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizePercent(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
}

export function getSummaryMetrics(summary: Pick<SessionContextSummary, "tokensUsed" | "contextWindow" | "tokensRemaining" | "usageRatio"> | null | undefined): SummaryMetrics {
  const used = optionalNumber(summary?.tokensUsed);
  const limit = optionalNumber(summary?.contextWindow);
  const remaining = optionalNumber(summary?.tokensRemaining);
  const ratioPercent = normalizePercent(summary?.usageRatio);
  const derivedPercent = used !== undefined && limit !== undefined && limit > 0
    ? Math.max(0, Math.min(100, (used / limit) * 100))
    : undefined;
  return {
    used,
    limit,
    remaining,
    percent: ratioPercent ?? derivedPercent,
  };
}

export function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(Math.round(value));
}

export function formatTokenValue(value: number): string {
  return `${formatNumber(value)} tokens`;
}

/** "840", "8.4k", "84k", "1.2M": short enough to read at a glance; the exact count goes in a title. */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return formatNumber(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "")}M`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export type ContextPressure = "room" | "compacting" | "blocking";

export function getContextPressure(percent: number | undefined, compactionPercent: number = COMPACTION_PERCENT): ContextPressure {
  if (percent === undefined || percent < compactionPercent) return "room";
  return percent < BLOCKING_PERCENT ? "compacting" : "blocking";
}

export function summarizeContext(
  summary: SessionContextSummary | null | undefined,
  capabilities: SessionContextCapabilities | undefined,
  loading: boolean | undefined,
  error: string | null | undefined,
): string {
  if (error) return "unavailable";
  const metrics = getSummaryMetrics(summary);
  if (metrics.percent !== undefined) return formatPercent(metrics.percent);
  if (metrics.used !== undefined) return `${formatCompactTokens(metrics.used)} tokens`;
  if (capabilities?.modelUsage === "unavailable") return "unavailable";
  if (loading) return "loading";
  return "pending";
}

/** Whether a reply now would reuse the cached prompt. */
export function describeCacheExpiry(iso: string | null | undefined, now: number): { warm: boolean; text: string } | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const minutes = Math.round(Math.abs(at - now) / 60_000);
  if (at > now) {
    return { warm: true, text: minutes < 1 ? "cache warm for under a minute" : `cache warm for ${minutes} more min` };
  }
  return { warm: false, text: minutes < 60 ? `cache expired ${Math.max(1, minutes)} min ago` : "cache expired" };
}

type Segment = { key: string; label: string; tokens: number; className: string };

function pressureFill(pressure: ContextPressure): string {
  return pressure === "blocking" ? "bg-error" : pressure === "compacting" ? "bg-warning" : "bg-text-secondary";
}

export function getMeterSegments(
  metrics: SummaryMetrics,
  breakdown: Pick<SessionContextBreakdown, "systemTokens" | "toolDefinitionsTokens"> | null | undefined,
  pressure: ContextPressure = getContextPressure(metrics.percent),
): Segment[] {
  if (metrics.used === undefined) return [];
  const fill = pressureFill(pressure);
  const system = breakdown?.systemTokens ?? undefined;
  const tools = breakdown?.toolDefinitionsTokens ?? undefined;
  if (system === undefined || tools === undefined || system + tools > metrics.used) {
    return [{ key: "used", label: "In use", tokens: metrics.used, className: fill }];
  }
  // The fixed parts come from the latest split; the conversation is whatever else the window holds now.
  // Shades step from darkest to lightest so the three stay apart in both themes.
  return [
    { key: "system", label: "Instructions", tokens: system, className: "bg-text-primary" },
    { key: "tools", label: "Tool definitions", tokens: tools, className: "bg-text-secondary" },
    {
      key: "conversation",
      label: "Conversation",
      tokens: metrics.used - system - tools,
      className: pressure === "room" ? "bg-text-faint" : fill,
    },
  ];
}

/** The window as one bar: what fills it, and ticks where compaction starts and where it blocks. */
export function ContextMeter({ metrics, segments, compactionPercent = COMPACTION_PERCENT }: {
  metrics: SummaryMetrics;
  segments: Segment[];
  compactionPercent?: number;
}) {
  if (metrics.used === undefined || metrics.limit === undefined || metrics.limit <= 0) return null;
  const percent = metrics.percent ?? 0;
  return (
    <div className="relative py-1">
      <div
        className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-bg-hover"
        role="progressbar"
        aria-label="Context window used"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${formatPercent(percent)} used; compaction starts at ${formatPercent(compactionPercent)}`}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cx("h-full shrink-0", segment.className)}
            style={{ width: `${Math.max(0, Math.min(100, (segment.tokens / metrics.limit!) * 100))}%` }}
          />
        ))}
      </div>
      {[compactionPercent, BLOCKING_PERCENT].map((tick) => (
        <span
          key={tick}
          aria-hidden="true"
          className="absolute top-0 h-4 w-px bg-text-faint"
          style={{ left: `${tick}%` }}
        />
      ))}
    </div>
  );
}

export function MeterLegend({ segments, mcpToolsTokens }: { segments: Segment[]; mcpToolsTokens?: number }) {
  if (segments.length < 2) return null;
  return (
    <ul className={cx("flex flex-wrap gap-x-4 gap-y-1", DS.usage.meta)}>
      {segments.map((segment) => (
        <li key={segment.key} className="inline-flex items-center gap-1.5" title={formatTokenValue(segment.tokens)}>
          <span aria-hidden="true" className={cx("h-2.5 w-2.5 shrink-0 rounded-[2px]", segment.className)} />
          {segment.label}
          <span className="text-text-primary">{formatCompactTokens(segment.tokens)}</span>
          {segment.key === "tools" && mcpToolsTokens !== undefined && mcpToolsTokens > 0 && (
            <span title="Definitions of tools from MCP servers">({formatCompactTokens(mcpToolsTokens)} from MCP)</span>
          )}
        </li>
      ))}
    </ul>
  );
}
