import type {
  CreateSessionOptions,
  ModelInfo,
  SessionModelState,
} from "../api";
import {
  getContextTierLabel,
  type CopilotContextTier,
} from "../../shared/copilot-context.js";
import { formatReasoningEffortLabel } from "../reasoning-effort";

export function buildOptimisticSessionModelState(
  options: CreateSessionOptions,
  defaultModelId?: string,
): SessionModelState | undefined {
  const model = options.model || defaultModelId;
  if (!model && !options.reasoningEffort && !options.contextTier) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.contextTier ? { contextTier: options.contextTier } : {}),
    source: "unknown",
  };
}

function formatContextTierFallbackLabel(tier?: CopilotContextTier): string | undefined {
  if (tier === "long_context") return "Long context";
  if (tier === "default") return "Standard context";
  return undefined;
}

export function formatSessionModelLabel(
  state?: SessionModelState,
  models?: readonly ModelInfo[] | null,
): string {
  if (!state) return "Loading...";
  if (!state.model) return "Unknown";
  const model = models?.find((candidate) => candidate.id === state.model);
  const modelLabel = model?.name ?? state.model;
  const effortLabel = formatReasoningEffortLabel(state.reasoningEffort);
  const contextTierLabel = getContextTierLabel(model, state.contextTier)
    ?? formatContextTierFallbackLabel(state.contextTier);
  return [modelLabel, effortLabel, contextTierLabel].filter(Boolean).join(" · ");
}

export function formatSessionModelSummaryLabel(
  state: SessionModelState,
  models?: readonly ModelInfo[] | null,
): string {
  const model = state.model
    ? models?.find((candidate) => candidate.id === state.model)
    : undefined;
  const modelLabel = model?.name
    ?? state.model
    ?? (state.source === "unknown" ? "Model unavailable" : "Default model");
  const effortLabel = formatReasoningEffortLabel(state.reasoningEffort) ?? "Default effort";
  const contextTierLabel = getContextTierLabel(model, state.contextTier)
    ?? formatContextTierFallbackLabel(state.contextTier)
    ?? "Default context";
  return [modelLabel, effortLabel, contextTierLabel].join(" · ");
}
