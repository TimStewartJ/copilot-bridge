import type { ChatEntry } from "../api";
import type {
  SessionContextCapabilities,
  SessionContextEvent,
  SessionContextFieldProvenance,
  SessionContextSummary,
  SessionContextTurn,
} from "../../shared/session-context.js";
import { DS } from "../design/tokens";
import { Badge } from "../design/primitives";

export type SummaryMetrics = {
  limit?: number;
  percent?: number;
  remaining?: number;
  used?: number;
};

export type ChatTurnPreview = {
  preview: string;
  role: "user" | "assistant";
  turnId?: string;
};

export type ChatTurnPreviews = {
  byTurnId: Map<string, ChatTurnPreview>;
  ordered: ChatTurnPreview[];
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

function trimPreview(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117)}…`;
}

function isTextEntry(entry: ChatEntry): entry is Extract<ChatEntry, { role: "user" | "assistant" }> {
  return entry.type !== "tool"
    && entry.type !== "visual"
    && entry.type !== "completion"
    && entry.type !== "skill"
    && entry.type !== "reasoning";
}

export function buildChatTurnPreviews(entries: ChatEntry[] | undefined): ChatTurnPreviews {
  const groups = new Map<string, { assistant?: string; user?: string }>();
  const orderedIds: string[] = [];
  const loose: ChatTurnPreview[] = [];

  for (const entry of entries ?? []) {
    if (!isTextEntry(entry)) continue;
    const preview = trimPreview(entry.content);
    if (!preview) continue;
    if (!entry.turnId) {
      loose.push({ preview, role: entry.role });
      continue;
    }
    if (!groups.has(entry.turnId)) {
      groups.set(entry.turnId, {});
      orderedIds.push(entry.turnId);
    }
    const group = groups.get(entry.turnId)!;
    if (entry.role === "user" && !group.user) group.user = preview;
    if (entry.role === "assistant" && !group.assistant) group.assistant = preview;
  }

  const byTurnId = new Map<string, ChatTurnPreview>();
  const ordered: ChatTurnPreview[] = [];
  for (const turnId of orderedIds) {
    const group = groups.get(turnId)!;
    const role = group.user ? "user" : "assistant";
    const preview = group.user ?? group.assistant;
    if (!preview) continue;
    const item = { preview, role, turnId } satisfies ChatTurnPreview;
    byTurnId.set(turnId, item);
    ordered.push(item);
  }

  return { byTurnId, ordered: [...ordered, ...loose] };
}

export function getTurnId(turn: SessionContextTurn): string | undefined {
  return turn.bridgeTurnId;
}

export function getTurnPreview(
  turn: SessionContextTurn,
  index: number,
  previews: ChatTurnPreviews,
): ChatTurnPreview | undefined {
  const turnId = getTurnId(turn);
  if (turnId) {
    const mapped = previews.byTurnId.get(turnId);
    if (mapped) return mapped;
  }
  return previews.ordered[index];
}

export function getTurnNumber(index: number): number {
  return index + 1;
}

export function eventTitle(event: SessionContextEvent): string {
  return event.type
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatUsagePair(used: number | null | undefined, limit: number | null | undefined): string | undefined {
  const normalizedUsed = optionalNumber(used);
  const normalizedLimit = optionalNumber(limit);
  if (normalizedUsed !== undefined && normalizedLimit !== undefined) {
    return `${formatNumber(normalizedUsed)}/${formatNumber(normalizedLimit)} tokens`;
  }
  if (normalizedUsed !== undefined) return formatTokenValue(normalizedUsed);
  return undefined;
}

export function eventUsageText(event: SessionContextEvent): string | undefined {
  const percent = normalizePercent(event.usageRatio);
  const usage = formatUsagePair(event.tokensUsed, event.contextWindow);
  if (percent !== undefined && usage) return `${formatPercent(percent)} · ${usage}`;
  return usage;
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

export function provenanceLabel(provenance: SessionContextFieldProvenance | null | undefined): string | undefined {
  if (!provenance) return undefined;
  const source = provenance.source === "live"
    ? "provider"
    : provenance.source;
  return provenance.confidence === "exact"
    ? source
    : `${source} ${provenance.confidence}`;
}

export function ProvenanceChip({ provenance }: { provenance?: SessionContextFieldProvenance | null }) {
  const label = provenanceLabel(provenance);
  if (!label) return null;
  const tone = provenance?.source === "estimated" ? "warning" : provenance?.source === "backfill" ? "info" : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
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
