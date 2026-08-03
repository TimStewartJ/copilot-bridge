import { describe, expect, it } from "vitest";
import {
  buildContextTierOptions,
  buildReasoningEffortOptions,
  resolveNewSessionLaunchState,
} from "./new-session-launch";

const TIERED_MODEL = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  supportedReasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "low",
  capabilities: {
    limits: {
      max_context_window_tokens: 1_050_000,
    },
  },
  billing: {
    tokenPrices: {
      contextMax: 272_000,
      longContext: {
        contextMax: 922_000,
      },
    },
  },
};

describe("resolveNewSessionLaunchState", () => {
  it("prefers the configured effort and highest context tier", () => {
    const state = resolveNewSessionLaunchState({
      models: [TIERED_MODEL],
      selectedModelId: "",
      defaultModelId: TIERED_MODEL.id,
      defaultReasoningEffort: "high",
    });

    expect(state.selectedReasoningEffort).toBe("high");
    expect(state.selectedContextTier).toBe("long_context");
    expect(state.reasoningEffortOptions.map((option) => option.label)).toEqual(["Low", "High"]);
    expect(state.contextOptions.map((option) => option.label)).toEqual([
      "Standard context (272K)",
      "Long context (922K)",
    ]);
  });

  it("preserves valid manual choices across metadata refreshes", () => {
    const state = resolveNewSessionLaunchState({
      models: [{ ...TIERED_MODEL }],
      selectedModelId: TIERED_MODEL.id,
      reasoningEffortSelection: { modelId: TIERED_MODEL.id, value: "low" },
      contextTierSelection: { modelId: TIERED_MODEL.id, value: "default" },
    });

    expect(state.selectedReasoningEffort).toBe("low");
    expect(state.selectedContextTier).toBe("default");
  });

  it("clamps stale choices when the selected model changes", () => {
    const state = resolveNewSessionLaunchState({
      models: [
        TIERED_MODEL,
        {
          id: "claude-haiku",
          name: "Claude Haiku",
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
          capabilities: {
            limits: {
              max_context_window_tokens: 128_000,
            },
          },
        },
      ],
      selectedModelId: "claude-haiku",
      reasoningEffortSelection: { modelId: TIERED_MODEL.id, value: "high" },
      contextTierSelection: { modelId: TIERED_MODEL.id, value: "long_context" },
    });

    expect(state.selectedReasoningEffort).toBe("medium");
    expect(state.selectedContextTier).toBeUndefined();
    expect(state.contextOptions).toEqual([{ value: null, label: "Default context (128K)" }]);
  });

  it("always exposes selected fallback buttons when metadata has no choices", () => {
    const state = resolveNewSessionLaunchState({
      models: [],
      selectedModelId: "",
    });

    expect(state.reasoningEffortOptions).toEqual([{ value: null, label: "Default" }]);
    expect(state.selectedReasoningEffort).toBeUndefined();
    expect(state.contextOptions).toEqual([{ value: null, label: "Default context" }]);
    expect(state.selectedContextTier).toBeUndefined();
  });
});

describe("launch option builders", () => {
  it("labels the supported efforts and falls back to an inert placeholder", () => {
    expect(buildReasoningEffortOptions(["low", "xhigh"])).toEqual([
      { value: "low", label: "Low" },
      { value: "xhigh", label: "Xhigh" },
    ]);
    expect(buildReasoningEffortOptions([])).toEqual([{ value: null, label: "Default" }]);
    expect(buildReasoningEffortOptions(undefined)).toEqual([{ value: null, label: "Default" }]);
  });

  it("builds tier choices only for models with a distinct long-context tier", () => {
    expect(buildContextTierOptions(TIERED_MODEL)).toEqual([
      { value: "default", label: "Standard context (272K)" },
      { value: "long_context", label: "Long context (922K)" },
    ]);
    expect(buildContextTierOptions({
      id: "claude-haiku",
      name: "Claude Haiku",
      capabilities: { limits: { max_context_window_tokens: 128_000 } },
    })).toEqual([{ value: null, label: "Default context (128K)" }]);
    expect(buildContextTierOptions(undefined)).toEqual([{ value: null, label: "Default context" }]);
  });
});
