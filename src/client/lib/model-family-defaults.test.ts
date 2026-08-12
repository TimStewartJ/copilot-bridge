import { describe, expect, it } from "vitest";
import type { ModelFamilyDefaults, ModelInfo } from "../api";
import {
  buildFamilyDefaultsPatch,
  resolveModelFamilyState,
  selectFamily,
} from "./model-family-defaults";

const MODELS: ModelInfo[] = [
  { id: "gpt-5.6", name: "GPT-5.6" },
  { id: "gpt-5-mini", name: "GPT-5 mini" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
];

describe("model family defaults", () => {
  it("uses SDK order as the family fallback while preserving explicit precedence", () => {
    const sdkOrderedModels: ModelInfo[] = [
      { id: "gpt-5.6", name: "GPT-5.6" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    ];

    const fallback = resolveModelFamilyState({
      models: sdkOrderedModels,
      selectedModelId: "gpt-5.6",
    });
    const selected = resolveModelFamilyState({
      models: sdkOrderedModels,
      selectedModelId: "claude-haiku-4.5",
    });
    const globalDefault = resolveModelFamilyState({
      models: sdkOrderedModels,
      selectedModelId: "",
      globalDefaultModelId: "claude-haiku-4.5",
    });

    expect(fallback.modelsByFamily.claude.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4.5",
    ]);
    expect(fallback.tiles.find((tile) => tile.family === "claude")?.model?.id)
      .toBe("claude-sonnet-5");
    expect(selected.tiles.find((tile) => tile.family === "claude")?.model?.id)
      .toBe("claude-haiku-4.5");
    expect(globalDefault.tiles.find((tile) => tile.family === "claude")?.model?.id)
      .toBe("claude-haiku-4.5");
  });

  it("uses the remembered model for each family", () => {
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "",
      familyDefaults: {
        gpt: { model: "gpt-5-mini" },
        claude: { model: "claude-opus-5" },
      },
    });

    expect(state.tiles.find((tile) => tile.family === "gpt")?.model?.id).toBe("gpt-5-mini");
    expect(state.tiles.find((tile) => tile.family === "claude")?.model?.id).toBe("claude-opus-5");
  });

  it("restores effort and context only for the remembered model", () => {
    const familyDefaults: ModelFamilyDefaults = {
      claude: {
        model: "claude-opus-5",
        reasoningEffort: "high",
        contextTier: "long_context",
      },
    };
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "",
      selectedFamily: "claude",
      familyDefaults,
    });

    expect(selectFamily({ family: "claude", state, familyDefaults })).toEqual({
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
  });

  it("retains other families when updating one remembered default", () => {
    expect(buildFamilyDefaultsPatch({
      current: { claude: { model: "claude-opus-5" } },
      modelId: "gpt-5-mini",
      reasoningEffort: "high",
    })).toEqual({
      claude: { model: "claude-opus-5" },
      gpt: { model: "gpt-5-mini", reasoningEffort: "high" },
    });
  });
});
