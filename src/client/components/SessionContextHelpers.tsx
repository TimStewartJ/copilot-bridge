import type {
  SessionContextCapabilities,
  SessionContextSummary,
} from "../../shared/session-context.js";
import { DS } from "../design/tokens";
import { Badge } from "../design/primitives";

export type SummaryMetrics = {
  limit?: number;
  percent?: number;
  remaining?: number;
  used?: number;
};

const NUMBER_FORMATTER = new Intl.NumberFormat();

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

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
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
  if (metrics.used !== undefined) return formatTokenValue(metrics.used);
  if (capabilities?.modelUsage === "unavailable") return "unavailable";
  if (loading) return "loading";
  return "pending";
}

export function capabilityLabel(value: SessionContextCapabilities[keyof SessionContextCapabilities]): string {
  switch (value) {
    case "exact": return "exact";
    case "partial": return "partial";
    case "marker": return "marker";
    case "unavailable": return "unavailable";
    default: return "unknown";
  }
}

export function CapabilityPill({ label, value }: { label: string; value?: SessionContextCapabilities[keyof SessionContextCapabilities] }) {
  if (!value) return null;
  // An exact reading is the ordinary case and takes no colour; only a weaker one is worth a look.
  const tone = value === "partial" || value === "marker" ? "warning" : "neutral";
  return (
    <Badge tone={tone}>
      {label}: {capabilityLabel(value)}
    </Badge>
  );
}

export function ContextMeter({ metrics }: { metrics: SummaryMetrics }) {
  if (metrics.used === undefined || metrics.limit === undefined) return null;
  const percent = metrics.percent ?? 0;
  // A window with room in it is not a state; the bar takes a colour only once it is filling up.
  const fill = percent >= 90 ? "bg-error" : percent >= 75 ? "bg-warning" : "bg-text-muted";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs tabular-nums text-text-muted">
        <span>{metrics.percent !== undefined ? `${formatPercent(metrics.percent)} used` : "Usage"}</span>
        <span>{formatNumber(metrics.used)} / {formatNumber(metrics.limit)} tokens</span>
      </div>
      <div className={DS.meter.track} role="progressbar" aria-label="Context used" aria-valuenow={metrics.percent} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`h-full rounded-full ${fill}`}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
    </div>
  );
}
