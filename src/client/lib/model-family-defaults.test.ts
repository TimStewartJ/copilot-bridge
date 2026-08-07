import { describe, expect, it } from "vitest";
import type { ModelFamilyDefaults, ModelInfo } from "../api";
import {
  buildFamilyDefaultsPatch,
  groupModelsByFamily,
  resolveModelFamilyState,
  selectFamily,
  selectModelInFamily,
} from "./model-family-defaults";

function model(id: string, name = id, policyState?: "enabled" | "disabled"): ModelInfo {
  return {
    id,
    name,
    ...(policyState ? { policy: { state: policyState } } : {}),
  };
}

const MODELS: ModelInfo[] = [
  model("auto", "Auto"),
  model("claude-sonnet-5", "Claude Sonnet 5"),
  model("claude-opus-5", "Claude Opus 5"),
  model("gpt-5.6-sol", "GPT-5.6 Sol"),
  model("gpt-5-mini", "GPT-5 mini"),
  model("gemini-3.1-pro", "Gemini 3.1 Pro"),
];

describe("groupModelsByFamily", () => {
  it("splits models by family and preserves API order", () => {
    const grouped = groupModelsByFamily(MODELS);
    expect(grouped.gpt.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5-mini"]);
    expect(grouped.claude.map((m) => m.id)).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    expect(grouped.other.map((m) => m.id)).toEqual(["auto", "gemini-3.1-pro"]);
  });

  it("drops disabled models", () => {
    const grouped = groupModelsByFamily([
      model("gpt-5.6-sol", "GPT-5.6 Sol", "enabled"),
      model("gpt-old", "GPT Old", "disabled"),
    ]);
    expect(grouped.gpt.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });
});

describe("resolveModelFamilyState", () => {
  it("gives every family a concrete model with no selection or memory", () => {
    const state = resolveModelFamilyState({ models: MODELS, selectedModelId: "" });
    const shown = Object.fromEntries(state.tiles.map((tile) => [tile.family, tile.model?.id]));
    expect(shown).toEqual({
      gpt: "gpt-5.6-sol",
      claude: "claude-sonnet-5",
      other: "auto",
    });
  });

  it("prefers sticky memory over the family's first model", () => {
    const familyDefaults: ModelFamilyDefaults = { gpt: { model: "gpt-5-mini" } };
    const state = resolveModelFamilyState({ models: MODELS, selectedModelId: "", familyDefaults });
    expect(state.tiles.find((tile) => tile.family === "gpt")?.model?.id).toBe("gpt-5-mini");
  });

  it("lets the live selection win over sticky memory so the tile matches reality", () => {
    const familyDefaults: ModelFamilyDefaults = { gpt: { model: "gpt-5-mini" } };
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "gpt-5.6-sol",
      familyDefaults,
    });
    expect(state.tiles.find((tile) => tile.family === "gpt")?.model?.id).toBe("gpt-5.6-sol");
  });

  it("falls back to the global default for its own family", () => {
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "",
      globalDefaultModelId: "claude-opus-5",
    });
    const claudeTile = state.tiles.find((tile) => tile.family === "claude");
    expect(claudeTile?.model?.id).toBe("claude-opus-5");
    expect(claudeTile?.isGlobalDefault).toBe(true);
  });

  it("ignores sticky memory pointing at a model that is no longer available", () => {
    const familyDefaults: ModelFamilyDefaults = { gpt: { model: "gpt-retired" } };
    const state = resolveModelFamilyState({ models: MODELS, selectedModelId: "", familyDefaults });
    expect(state.tiles.find((tile) => tile.family === "gpt")?.model?.id).toBe("gpt-5.6-sol");
  });

  it("marks the selected model's family live", () => {
    const state = resolveModelFamilyState({ models: MODELS, selectedModelId: "gemini-3.1-pro" });
    expect(state.liveFamily).toBe("other");
    expect(state.tiles.filter((tile) => tile.isLive).map((tile) => tile.family)).toEqual(["other"]);
  });

  it("treats an empty selection as living in the global default's family", () => {
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "",
      globalDefaultModelId: "claude-opus-5",
    });
    expect(state.liveFamily).toBe("claude");
  });

  it("lets a remembered family override the global default for an empty model override", () => {
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "",
      selectedFamily: "claude",
      globalDefaultModelId: "gpt-5.6-sol",
    });
    expect(state.liveFamily).toBe("claude");
  });

  it("ignores a remembered family that has no available models", () => {
    const state = resolveModelFamilyState({
      models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
      selectedModelId: "",
      selectedFamily: "claude",
      globalDefaultModelId: "gpt-5.6-sol",
    });
    expect(state.liveFamily).toBe("gpt");
  });

  it("derives the live family from an unlisted selected model", () => {
    const state = resolveModelFamilyState({ models: MODELS, selectedModelId: "claude-preview-9" });
    expect(state.liveFamily).toBe("claude");
  });

  it("leaves a family without models unselectable", () => {
    const state = resolveModelFamilyState({
      models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
      selectedModelId: "",
    });
    expect(state.tiles.find((tile) => tile.family === "claude")?.model).toBeUndefined();
    expect(state.tiles.find((tile) => tile.family === "other")?.model).toBeUndefined();
  });
});

describe("selectModelInFamily", () => {
  it("emits an empty id for the global default so inheritance is preserved", () => {
    const selection = selectModelInFamily({
      modelId: "claude-opus-5",
      globalDefaultModelId: "claude-opus-5",
    });
    expect(selection.modelId).toBe("");
    expect(selection.resolvedModelId).toBe("claude-opus-5");
  });

  it("emits an explicit id for a non-default model", () => {
    const selection = selectModelInFamily({
      modelId: "gpt-5-mini",
      globalDefaultModelId: "claude-opus-5",
    });
    expect(selection.modelId).toBe("gpt-5-mini");
  });

  it("restores stored effort and context for the remembered model", () => {
    const familyDefaults: ModelFamilyDefaults = {
      gpt: { model: "gpt-5-mini", reasoningEffort: "high", contextTier: "long_context" },
    };
    const selection = selectModelInFamily({ modelId: "gpt-5-mini", familyDefaults });
    expect(selection.reasoningEffort).toBe("high");
    expect(selection.contextTier).toBe("long_context");
  });

  it("does not carry stored effort onto a different model in the family", () => {
    const familyDefaults: ModelFamilyDefaults = {
      gpt: { model: "gpt-5-mini", reasoningEffort: "high", contextTier: "long_context" },
    };
    const selection = selectModelInFamily({ modelId: "gpt-5.6-sol", familyDefaults });
    expect(selection.reasoningEffort).toBeUndefined();
    expect(selection.contextTier).toBeUndefined();
  });
});

describe("selectFamily", () => {
  it("returns the tile's model as a full selection", () => {
    const familyDefaults: ModelFamilyDefaults = {
      claude: { model: "claude-opus-5", reasoningEffort: "xhigh" },
    };
    const state = resolveModelFamilyState({ models: MODELS, selectedModelId: "", familyDefaults });
    const selection = selectFamily({ family: "claude", state, familyDefaults });
    expect(selection?.resolvedModelId).toBe("claude-opus-5");
    expect(selection?.reasoningEffort).toBe("xhigh");
  });

  it("returns null for a family with no available models", () => {
    const state = resolveModelFamilyState({
      models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
      selectedModelId: "",
    });
    expect(selectFamily({ family: "claude", state })).toBeNull();
  });
});

describe("buildFamilyDefaultsPatch", () => {
  it("records a new family entry", () => {
    const patch = buildFamilyDefaultsPatch({
      current: undefined,
      modelId: "gpt-5-mini",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
    expect(patch).toEqual({
      gpt: { model: "gpt-5-mini", reasoningEffort: "high", contextTier: "long_context" },
    });
  });

  it("leaves other families untouched", () => {
    const patch = buildFamilyDefaultsPatch({
      current: { claude: { model: "claude-opus-5" } },
      modelId: "gpt-5-mini",
    });
    expect(patch).toEqual({
      claude: { model: "claude-opus-5" },
      gpt: { model: "gpt-5-mini" },
    });
  });

  it("returns null when nothing changed so no redundant write happens", () => {
    const current: ModelFamilyDefaults = {
      gpt: { model: "gpt-5-mini", reasoningEffort: "high" },
    };
    expect(buildFamilyDefaultsPatch({
      current,
      modelId: "gpt-5-mini",
      reasoningEffort: "high",
    })).toBeNull();
  });

  it("returns null without a model id", () => {
    expect(buildFamilyDefaultsPatch({ current: undefined, modelId: "" })).toBeNull();
  });

  it("omits empty effort and context rather than storing blanks", () => {
    const patch = buildFamilyDefaultsPatch({
      current: undefined,
      modelId: "gpt-5-mini",
      reasoningEffort: "",
    });
    expect(patch).toEqual({ gpt: { model: "gpt-5-mini" } });
  });
});
