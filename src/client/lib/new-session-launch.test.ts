import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../api";
import {
  buildNewSessionCreateOptions,
  resolveNewSessionLaunchState,
} from "./new-session-launch";

const TIERED_MODEL: ModelInfo = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  supportedReasoningEfforts: ["low", "high", "xhigh"],
  capabilities: {
    limits: {
      max_context_window_tokens: 1_050_000,
      max_output_tokens: 128_000,
      max_prompt_tokens: 922_000,
    },
  },
  billing: {
    tokenPrices: {
      contextMax: 272_000,
      longContext: { contextMax: 922_000 },
    },
  },
};

describe("new-session launch state", () => {
  it("preserves SDK model order while filtering disabled models", () => {
    const state = resolveNewSessionLaunchState({
      models: [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        {
          id: "claude-disabled",
          name: "Claude Aardvark",
          policy: { state: "disabled" },
        },
      ],
      selectedModelId: "",
    });

    expect(state.availableModels.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4.5",
    ]);
  });

  it("selects concrete inherited effort and context values", () => {
    const state = resolveNewSessionLaunchState({
      models: [TIERED_MODEL],
      selectedModelId: "",
      defaultModelId: TIERED_MODEL.id,
      defaultReasoningEffort: "xhigh",
      defaultContextTier: "long_context",
    });

    expect(state.modelKey).toBe(TIERED_MODEL.id);
    expect(state.modelForCreate).toBe(TIERED_MODEL.id);
    expect(state.selectedReasoningEffort).toBe("xhigh");
    expect(state.selectedContextTier).toBe("long_context");
    expect(state.reasoningEffortOptions).toEqual([
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Xhigh" },
    ]);
    expect(state.contextOptions).toEqual([
      { value: "default", label: "Standard context (272K)" },
      { value: "long_context", label: "Long context (922K)" },
    ]);
    expect(buildNewSessionCreateOptions(state)).toEqual({
      model: TIERED_MODEL.id,
      reasoningEffort: "xhigh",
      contextTier: "long_context",
    });
  });

  it("keeps valid model-scoped choices ahead of inherited values", () => {
    const state = resolveNewSessionLaunchState({
      models: [TIERED_MODEL],
      selectedModelId: TIERED_MODEL.id,
      defaultReasoningEffort: "xhigh",
      defaultContextTier: "long_context",
      reasoningEffortSelection: { modelId: TIERED_MODEL.id, value: "low" },
      contextTierSelection: { modelId: TIERED_MODEL.id, value: "default" },
    });

    expect(state.selectedReasoningEffort).toBe("low");
    expect(state.selectedContextTier).toBe("default");
  });

  it("uses an advertised model effort default but never guesses from option order", () => {
    const advertisedDefault = resolveNewSessionLaunchState({
      models: [{ ...TIERED_MODEL, defaultReasoningEffort: "high" }],
      selectedModelId: TIERED_MODEL.id,
      defaultReasoningEffort: "unsupported",
    });
    const unreportedDefault = resolveNewSessionLaunchState({
      models: [TIERED_MODEL],
      selectedModelId: TIERED_MODEL.id,
      defaultReasoningEffort: "unsupported",
    });

    expect(advertisedDefault.selectedReasoningEffort).toBe("high");
    expect(unreportedDefault.selectedReasoningEffort).toBeUndefined();
    expect(unreportedDefault.reasoningEffortOptions.every((option) => option.value !== null)).toBe(true);
  });

  it("shows a concrete standard context choice for models without a long tier", () => {
    const state = resolveNewSessionLaunchState({
      models: [{
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        capabilities: { limits: { max_context_window_tokens: 128_000 } },
      }],
      selectedModelId: "gpt-5-mini",
      defaultContextTier: "long_context",
    });

    expect(state.contextOptions).toEqual([
      { value: "default", label: "Standard context (128K)" },
    ]);
    expect(state.selectedContextTier).toBe("default");
  });

  it("does not expose fixed options for dynamically selected models", () => {
    const state = resolveNewSessionLaunchState({
      models: [{
        id: "hydrafusion",
        name: "HydraFusion (Research Preview)",
        selectionMode: "dynamic",
        supportedReasoningEfforts: [],
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 0 },
        },
      }],
      selectedModelId: "hydrafusion",
      defaultReasoningEffort: "xhigh",
      defaultContextTier: "long_context",
    });

    expect(state.reasoningEffortOptions).toEqual([]);
    expect(state.selectedReasoningEffort).toBeUndefined();
    expect(state.contextOptions).toEqual([]);
    expect(state.selectedContextTier).toBeUndefined();
    expect(buildNewSessionCreateOptions(state)).toEqual({ model: "hydrafusion" });
  });

  it("does not invent launch options or freeze an inherited model before it is known", () => {
    const state = resolveNewSessionLaunchState({
      models: [],
      selectedModelId: "",
      defaultModelId: TIERED_MODEL.id,
    });

    expect(state.modelKey).toBe(TIERED_MODEL.id);
    expect(state.modelForCreate).toBeUndefined();
    expect(state.reasoningEffortOptions).toEqual([]);
    expect(state.contextOptions).toEqual([]);
    expect(buildNewSessionCreateOptions(state)).toEqual({});
  });

  it("does not submit an unavailable persisted model selection", () => {
    const state = resolveNewSessionLaunchState({
      models: [TIERED_MODEL],
      selectedModelId: "removed-model",
      defaultModelId: TIERED_MODEL.id,
    });

    expect(state.modelKey).toBe("removed-model");
    expect(state.modelForCreate).toBeUndefined();
    expect(buildNewSessionCreateOptions(state)).toEqual({});
  });
});
