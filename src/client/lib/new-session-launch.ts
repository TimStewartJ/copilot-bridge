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
  const reasoningEffortOptions = supportedEfforts.length > 0
    ? supportedEfforts.map((value) => ({
        value,
        label: formatReasoningEffortLabel(value) ?? value,
      }))
    : [{ value: null, label: "Default" }];
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

  if (modelSupportsLongContext(effectiveModel)) {
    const contextOptions: LaunchOption<CopilotContextTier>[] = [
      {
        value: "default",
        label: getContextTierLabel(effectiveModel, "default") ?? "Standard context",
      },
      {
        value: "long_context",
        label: getContextTierLabel(effectiveModel, "long_context") ?? "Long context",
      },
    ];
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

  const defaultContextTokens = getContextWindowTokensForTier(effectiveModel, "default");
  const defaultContextLabel = defaultContextTokens
    ? `Default context (${formatContextWindowTokens(defaultContextTokens)})`
    : "Default context";
  return {
    availableModels,
    effectiveModel,
    modelKey,
    reasoningEffortOptions,
    selectedReasoningEffort,
    contextOptions: [{ value: null, label: defaultContextLabel }],
  };
}
