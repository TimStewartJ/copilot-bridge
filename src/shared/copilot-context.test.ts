import { describe, expect, it } from "vitest";
import {
  getContextPromptTokensForTier,
  modelSupportsLongContext,
  resolveContextTierForModel,
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
      maxPromptTokens: 272_000,
      longContext: {
        maxPromptTokens: 922_000,
      },
    },
  },
};

describe("copilot context tiers", () => {
  it("prefers canonical prompt budgets over the legacy catalog alias", () => {
    const model = {
      ...TIERED_MODEL,
      billing: {
        tokenPrices: {
          maxPromptTokens: 200_000,
          contextMax: 72_000,
          longContext: { maxPromptTokens: 1_000_000, contextMax: 968_000 },
        },
      },
    };
    expect(modelSupportsLongContext(model)).toBe(true);
    expect(getContextPromptTokensForTier(model, "default")).toBe(200_000);
    expect(getContextPromptTokensForTier(model, "long_context")).toBe(1_000_000);
  });

  it("does not label a combined context ceiling as a prompt budget", () => {
    expect(getContextPromptTokensForTier({
      id: "untiered-model",
      capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    }, undefined)).toBeUndefined();
  });

  it("selects native tiers only for models that advertise them", () => {
    expect(resolveContextTierForModel(TIERED_MODEL, undefined)).toBe("default");
    expect(resolveContextTierForModel(TIERED_MODEL, "long_context")).toBe("long_context");
    expect(resolveContextTierForModel({ id: "untiered-model" }, "long_context")).toBeUndefined();
  });
});
