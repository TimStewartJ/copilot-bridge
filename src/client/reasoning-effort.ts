import type { ModelInfo } from "./api";

/**
 * Humanize an SDK reasoning-effort id for display. The set of efforts is
 * entirely SDK-driven, so this formats any value generically rather than
 * matching against a fixed list (e.g. "xhigh" -> "Xhigh", "extra_high" ->
 * "Extra High"). Returns undefined for empty input.
 */
export function formatReasoningEffortLabel(effort?: string): string | undefined {
  if (!effort) return undefined;
  return effort
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Resolve the reasoning efforts to surface for a given model selection,
 * straight from the SDK model metadata.
 *
 * - A known model returns its own supported efforts (possibly empty when the
 *   model advertises none).
 * - An unknown or unset model falls back to the union of efforts across all
 *   models, so a default selector still has something meaningful to show.
 */
export function getModelReasoningEfforts(
  models: readonly ModelInfo[] | null | undefined,
  modelId?: string,
): string[] {
  const list = models ?? [];
  if (modelId) {
    const selected = list.find((model) => model.id === modelId);
    if (selected) return [...(selected.supportedReasoningEfforts ?? [])];
  }
  const union = new Set<string>();
  for (const model of list) {
    for (const effort of model.supportedReasoningEfforts ?? []) union.add(effort);
  }
  return [...union];
}
