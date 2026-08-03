import type { ModelInfo } from "../api";
import { formatReasoningEffortLabel } from "../reasoning-effort";
import {
  formatContextWindowTokens,
  getContextTierLabel,
  getContextWindowTokensForTier,
  modelSupportsLongContext,
  type CopilotContextTier,
} from "../../shared/copilot-context.js";

export interface ScopedLaunchSelection<T> {
  modelId: string;
  value: T;
}

export interface LaunchOption<T> {
  value: T | null;
  label: string;
}

interface ResolveNewSessionLaunchStateOptions {
  models: readonly ModelInfo[];
  selectedModelId: string;
  defaultModelId?: string;
  defaultReasoningEffort?: string;
  reasoningEffortSelection?: ScopedLaunchSelection<string> | null;
  contextTierSelection?: ScopedLaunchSelection<CopilotContextTier> | null;
}

export interface NewSessionLaunchState {
  availableModels: ModelInfo[];
  effectiveModel?: ModelInfo;
  modelKey: string;
  reasoningEffortOptions: LaunchOption<string>[];
  selectedReasoningEffort?: string;
  contextOptions: LaunchOption<CopilotContextTier>[];
  selectedContextTier?: CopilotContextTier;
}

/**
 * Effort choices for a model, shared by the new-chat screen and the
 * change-model dialog. Models without effort metadata get an inert placeholder
 * so the row still renders.
 */
export function buildReasoningEffortOptions(
  supportedEfforts: readonly string[] | undefined,
): LaunchOption<string>[] {
  if (!supportedEfforts || supportedEfforts.length === 0) {
    return [{ value: null, label: "Default" }];
  }
  return supportedEfforts.map((value) => ({
    value,
    label: formatReasoningEffortLabel(value) ?? value,
  }));
}

/**
 * Context-tier choices for a model. Models without a distinct long-context tier
 * get an inert placeholder that names the only available context window.
 */
export function buildContextTierOptions(
  model: ModelInfo | undefined,
): LaunchOption<CopilotContextTier>[] {
  if (modelSupportsLongContext(model)) {
    return [
      {
        value: "default",
        label: getContextTierLabel(model, "default") ?? "Standard context",
      },
      {
        value: "long_context",
        label: getContextTierLabel(model, "long_context") ?? "Long context",
      },
    ];
  }

  const defaultContextTokens = getContextWindowTokensForTier(model, "default");
  return [{
    value: null,
    label: defaultContextTokens
      ? `Default context (${formatContextWindowTokens(defaultContextTokens)})`
      : "Default context",
  }];
}

export function resolveNewSessionLaunchState({
  models,
  selectedModelId,
  defaultModelId,
  defaultReasoningEffort,
  reasoningEffortSelection,
  contextTierSelection,
}: ResolveNewSessionLaunchStateOptions): NewSessionLaunchState {
  const availableModels = models
    .filter((model) => model.policy?.state !== "disabled")
    .sort((left, right) => left.name.localeCompare(right.name));
  const effectiveModelId = selectedModelId || defaultModelId;
  const effectiveModel = effectiveModelId
    ? availableModels.find((model) => model.id === effectiveModelId)
    : undefined;
  const modelKey = effectiveModel?.id ?? effectiveModelId ?? "";

  const supportedEfforts = [...(effectiveModel?.supportedReasoningEfforts ?? [])];
  const reasoningEffortOptions = buildReasoningEffortOptions(supportedEfforts);
  const automaticEffort = supportedEfforts.includes(defaultReasoningEffort ?? "")
    ? defaultReasoningEffort
    : supportedEfforts.includes(effectiveModel?.defaultReasoningEffort ?? "")
      ? effectiveModel?.defaultReasoningEffort
      : supportedEfforts[0];
  const selectedReasoningEffort =
    reasoningEffortSelection?.modelId === modelKey
      && supportedEfforts.includes(reasoningEffortSelection.value)
      ? reasoningEffortSelection.value
      : automaticEffort;

  const contextOptions = buildContextTierOptions(effectiveModel);
  if (modelSupportsLongContext(effectiveModel)) {
    const selectedContextTier =
      contextTierSelection?.modelId === modelKey
        && contextOptions.some((option) => option.value === contextTierSelection.value)
        ? contextTierSelection.value
        : "long_context";
    return {
      availableModels,
      effectiveModel,
      modelKey,
      reasoningEffortOptions,
      selectedReasoningEffort,
      contextOptions,
      selectedContextTier,
    };
  }

  return {
    availableModels,
    effectiveModel,
    modelKey,
    reasoningEffortOptions,
    selectedReasoningEffort,
    contextOptions,
  };
}
