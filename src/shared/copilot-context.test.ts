import { describe, expect, it } from "vitest";
import {
  getContextWindowTokensForTier,
  getModelCapabilitiesOverride,
  getModelCapabilitiesOverrideForContextTier,
} from "./copilot-context.js";

const TIERED_MODEL = {
  id: "gpt-5.5",
  capabilities: {
    limits: {
      max_context_window_tokens: 1_050_000,
      max_prompt_tokens: 922_000,
      max_output_tokens: 128_000,
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

describe("copilot context tiers", () => {
  it("caps tiered models to the default prompt budget", () => {
    expect(getModelCapabilitiesOverrideForContextTier(TIERED_MODEL, "default")).toEqual({
      limits: {
        max_context_window_tokens: 272_000,
        max_prompt_tokens: 144_000,
      },
    });
  });

  it("explicitly restores full model limits for long context", () => {
    expect(getModelCapabilitiesOverrideForContextTier(TIERED_MODEL, "long_context")).toEqual({
      limits: {
        max_context_window_tokens: 1_050_000,
        max_prompt_tokens: 922_000,
      },
    });
  });

  it("uses the tier-specific context window for labels", () => {
    expect(getContextWindowTokensForTier(TIERED_MODEL, "default")).toBe(272_000);
    expect(getContextWindowTokensForTier(TIERED_MODEL, "long_context")).toBe(922_000);
  });

  it("merges persisted overrides with context-tier limits, letting the tier win on conflicts", () => {
    expect(getModelCapabilitiesOverride(
      TIERED_MODEL,
      "default",
      { limits: { max_prompt_tokens: 900_000 }, supports: { vision: true } },
    )).toEqual({
      limits: { max_context_window_tokens: 272_000, max_prompt_tokens: 144_000 },
      supports: { vision: true },
    });
  });

  it("returns undefined when neither the tier nor a persisted override adds anything", () => {
    expect(getModelCapabilitiesOverride(
      {
        id: "adaptive-model",
        capabilities: {
          supports: { adaptive_thinking: "optional" },
        },
      },
      undefined,
    )).toBeUndefined();
  });

  it("drops the legacy adaptive_thinking key persisted by CLI <= 1.0.80 builds", () => {
    expect(getModelCapabilitiesOverride(
      { id: "adaptive-model" },
      undefined,
      { supports: { adaptive_thinking: "required" } },
    )).toBeUndefined();
    expect(getModelCapabilitiesOverride(
      { id: "adaptive-model" },
      undefined,
      { limits: { max_prompt_tokens: 900_000 }, supports: { adaptive_thinking: "required", vision: true } },
    )).toEqual({
      limits: { max_prompt_tokens: 900_000 },
      supports: { vision: true },
    });
  });
});
