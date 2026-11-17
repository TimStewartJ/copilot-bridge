import type { ModelInfo } from "./api";

/** Model-named label if any; else format generically, as effort ids come from the SDK. */
export function formatReasoningEffortLabel(
  effort?: string,
  model?: Pick<ModelInfo, "reasoningEffortLabels"> | null,
): string | undefined {
  if (!effort) return undefined;
  const named = model?.reasoningEffortLabels?.[effort];
  if (named) return named;
  return effort
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A known model's efforts; for an unknown or unset model, the union across all models. */
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
