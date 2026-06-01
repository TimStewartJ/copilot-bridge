import { describe, expect, it } from "vitest";
import {
  getContextWindowTokensForTier,
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
});
