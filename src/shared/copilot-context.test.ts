import { describe, expect, it } from "vitest";
import {
  getContextWindowTokensForTier,
  getModelCapabilitiesOverride,
  inferContextTierFromCapabilities,
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
    expect(getModelCapabilitiesOverride(TIERED_MODEL, "default")).toEqual({
      limits: {
        max_context_window_tokens: 272_000,
        max_prompt_tokens: 144_000,
      },
    });
  });

  it("explicitly restores full model limits for long context", () => {
    expect(getModelCapabilitiesOverride(TIERED_MODEL, "long_context")).toEqual({
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

  it("recovers context tiers from persisted capability overrides", () => {
    expect(inferContextTierFromCapabilities(TIERED_MODEL, {
      limits: {
        max_context_window_tokens: 1_050_000,
        max_prompt_tokens: 922_000,
      },
    })).toBe("long_context");
    expect(inferContextTierFromCapabilities(TIERED_MODEL, {
      limits: {
        max_context_window_tokens: 272_000,
        max_prompt_tokens: 144_000,
      },
    })).toBe("default");
  });

  it("does not infer a tier from unrelated capability limits", () => {
    expect(inferContextTierFromCapabilities(TIERED_MODEL, {
      limits: {
        max_context_window_tokens: 500_000,
        max_prompt_tokens: 400_000,
      },
    })).toBeUndefined();
  });

  it("returns undefined for models without tiered context limits", () => {
    expect(getModelCapabilitiesOverride({ id: "untiered-model", capabilities: {} }, "default")).toBeUndefined();
    expect(getModelCapabilitiesOverride(TIERED_MODEL, undefined)).toBeUndefined();
  });
});
