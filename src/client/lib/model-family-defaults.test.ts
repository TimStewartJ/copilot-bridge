import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../api";
import {
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
    expect(grouped.gpt.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-5-mini"]);
    expect(grouped.claude.map((entry) => entry.id)).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    expect(grouped.other.map((entry) => entry.id)).toEqual(["auto", "gemini-3.1-pro"]);
  });

  it("drops disabled models", () => {
    const grouped = groupModelsByFamily([
      model("gpt-5.6-sol", "GPT-5.6 Sol", "enabled"),
      model("gpt-old", "GPT Old", "disabled"),
    ]);
    expect(grouped.gpt.map((entry) => entry.id)).toEqual(["gpt-5.6-sol"]);
  });
});

describe("resolveModelFamilyState", () => {
  it("uses API order when there is no explicit or global selection", () => {
    const state = resolveModelFamilyState({ models: MODELS, selectedModelId: "" });
    expect(Object.fromEntries(state.tiles.map((tile) => [tile.family, tile.model?.id]))).toEqual({
      gpt: "gpt-5.6-sol",
      claude: "claude-sonnet-5",
      other: "auto",
    });
  });

  it("lets the current explicit selection win for its family", () => {
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "gpt-5-mini",
      globalDefaultModelId: "gpt-5.6-sol",
    });
    expect(state.tiles.find((tile) => tile.family === "gpt")?.model?.id).toBe("gpt-5-mini");
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

  it("honors a draft-selected family when no model override exists", () => {
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "",
      selectedFamily: "claude",
      globalDefaultModelId: "gpt-5.6-sol",
    });
    expect(state.liveFamily).toBe("claude");
  });

  it("ignores a selected family that has no available models", () => {
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

describe("model family selections", () => {
  it("keeps a user pick explicit even when it matches the global default", () => {
    expect(selectModelInFamily({ modelId: "claude-opus-5" })).toEqual({
      modelId: "claude-opus-5",
    });
  });

  it("returns the model shown by a family tile", () => {
    const state = resolveModelFamilyState({
      models: MODELS,
      selectedModelId: "",
      globalDefaultModelId: "claude-opus-5",
    });
    expect(selectFamily({ family: "claude", state })).toEqual({
      modelId: "claude-opus-5",
    });
  });

  it("returns null for a family with no available models", () => {
    const state = resolveModelFamilyState({
      models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
      selectedModelId: "",
    });
    expect(selectFamily({ family: "claude", state })).toBeNull();
  });
});
