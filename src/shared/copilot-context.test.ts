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

  it("uses adaptive thinking for explicit effort while preserving other overrides", () => {
    expect(getModelCapabilitiesOverride(
      {
        id: "adaptive-model",
        capabilities: {
          supports: { adaptive_thinking: "optional" },
        },
      },
      undefined,
      "high",
      { limits: { max_prompt_tokens: 900_000 } },
    )).toEqual({
      limits: { max_prompt_tokens: 900_000 },
      supports: { adaptive_thinking: "required" },
    });
  });

  it("does not force adaptive thinking when no effort is selected", () => {
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
});
