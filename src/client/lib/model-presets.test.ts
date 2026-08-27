import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelPresets } from "../api";
import {
  buildModelPresetsPatch,
  findPresetSlotForModel,
  migrateLegacyFamilyDefaults,
  resolveModelPresetState,
  selectPreset,
} from "./model-presets";

const MODELS: ModelInfo[] = [
  { id: "gpt-5.6", name: "GPT-5.6" },
  { id: "gpt-5-mini", name: "GPT-5 mini" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
];

describe("model presets", () => {
  it("starts the three slots with GPT, Claude, and Other models", () => {
    const state = resolveModelPresetState({
      models: MODELS,
      selectedModelId: "gpt-5.6",
    });

    expect(state.tiles.map((tile) => tile.model?.id)).toEqual([
      "gpt-5.6",
      "claude-sonnet-5",
      "gemini-3.1-pro",
    ]);
  });

  it("keeps each configured preset in its slot regardless of model family", () => {
    const state = resolveModelPresetState({
      models: MODELS,
      selectedModelId: "claude-opus-5",
      selectedPresetSlot: "preset1",
      presets: {
        preset1: { model: "claude-opus-5" },
        preset2: { model: "gpt-5-mini" },
      },
    });

    expect(state.tiles.map((tile) => tile.model?.id)).toEqual([
      "claude-opus-5",
      "gpt-5-mini",
      "gemini-3.1-pro",
    ]);
    expect(state.liveSlot).toBe("preset1");
    expect(state.availableModels.map((model) => model.id)).toEqual(MODELS.map((model) => model.id));
  });

  it("restores effort and context for the selected preset", () => {
    const presets: ModelPresets = {
      preset2: {
        model: "claude-opus-5",
        reasoningEffort: "high",
        contextTier: "long_context",
      },
    };
    const state = resolveModelPresetState({
      models: MODELS,
      selectedModelId: "",
      selectedPresetSlot: "preset2",
      presets,
    });

    expect(selectPreset({ slot: "preset2", state, presets })).toEqual({
      slot: "preset2",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
  });

  it("retains other slots when updating one preset", () => {
    expect(buildModelPresetsPatch({
      current: { preset2: { model: "claude-opus-5" } },
      slot: "preset1",
      modelId: "gpt-5-mini",
      reasoningEffort: "high",
    })).toEqual({
      preset1: { model: "gpt-5-mini", reasoningEffort: "high" },
      preset2: { model: "claude-opus-5" },
    });
  });

  it("prefers the last-used slot when duplicate presets use the same model", () => {
    expect(findPresetSlotForModel({
      modelId: "gpt-5.6",
      models: MODELS,
      presets: {
        preset1: { model: "gpt-5.6" },
        preset2: { model: "gpt-5.6" },
      },
      preferredSlot: "preset2",
    })).toBe("preset2");
  });

  it("migrates legacy family memory into the initial preset slots", () => {
    expect(migrateLegacyFamilyDefaults({
      gpt: { model: "gpt-5-mini" },
      claude: { model: "claude-opus-5", contextTier: "long_context" },
    })).toEqual({
      preset1: { model: "gpt-5-mini" },
      preset2: { model: "claude-opus-5", contextTier: "long_context" },
    });
  });
});
