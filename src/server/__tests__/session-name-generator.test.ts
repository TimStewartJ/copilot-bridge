import { describe, expect, it } from "vitest";
import {
  buildSessionTitleUserPrompt,
  createDisposableTitleSessionId,
  extractGeneratedSessionTitle,
  isDisposableTitleSessionId,
  selectSessionTitleModel,
} from "../session-name-generator.js";

describe("session name generator helpers", () => {
  it("marks disposable title helper session ids with a recognizable prefix", () => {
    const sessionId = createDisposableTitleSessionId();

    expect(sessionId).toMatch(/^b17e1000-/);
    expect(isDisposableTitleSessionId(sessionId)).toBe(true);
    expect(isDisposableTitleSessionId("regular-session")).toBe(false);
  });

  it("prefers free small models before other free or cheap models", () => {
    const model = selectSessionTitleModel([
      { id: "expensive-mini", billing: { multiplier: 1 } },
      { id: "free-large", billing: { multiplier: 0 } },
      { id: "free-haiku", billing: { multiplier: 0 } },
      { id: "cheap-mini", billing: { multiplier: 0.25 } },
    ] as any);

    expect(model).toBe("free-haiku");
  });

  it("falls back to cheap small models and skips expensive-only model lists", () => {
    expect(selectSessionTitleModel([
      { id: "cheap-mini", billing: { multiplier: 0.25 } },
      { id: "expensive-haiku", billing: { multiplier: 2 } },
    ] as any)).toBe("cheap-mini");

    expect(selectSessionTitleModel([
      { id: "expensive-opus", billing: { multiplier: 2 } },
    ] as any)).toBeUndefined();
  });

  it("selects the cheapest small model from token price billing", () => {
    const model = selectSessionTitleModel([
      { id: "auto" },
      { id: "aaa-mini-expensive", billing: { tokenPrices: { inputPrice: 200_000_000_000, outputPrice: 800_000_000_000, cachePrice: 20_000_000_000, batchSize: 1_000_000 } } },
      { id: "gpt-5.5", billing: { tokenPrices: { inputPrice: 500_000_000_000, outputPrice: 3_000_000_000_000, cachePrice: 50_000_000_000, batchSize: 1_000_000 } } },
      { id: "claude-haiku-4.5", billing: { tokenPrices: { inputPrice: 100_000_000_000, outputPrice: 500_000_000_000, cachePrice: 10_000_000_000, batchSize: 1_000_000 } } },
      { id: "gpt-5.4-mini", billing: { tokenPrices: { inputPrice: 75_000_000_000, outputPrice: 450_000_000_000, cachePrice: 7_500_000_000, batchSize: 1_000_000 } } },
      { id: "gpt-5-mini", billing: { tokenPrices: { inputPrice: 25_000_000_000, outputPrice: 200_000_000_000, cachePrice: 2_500_000_000, batchSize: 1_000_000 } } },
    ] as any);

    expect(model).toBe("gpt-5-mini");
  });

  it("preserves free-model preference with token price billing", () => {
    const model = selectSessionTitleModel([
      { id: "free-large", billing: { tokenPrices: { inputPrice: 0, outputPrice: 0, cachePrice: 0, batchSize: 1_000_000 } } },
      { id: "free-haiku", billing: { tokenPrices: { inputPrice: 0, outputPrice: 0, cachePrice: 0, batchSize: 1_000_000 } } },
      { id: "gpt-5-mini", billing: { tokenPrices: { inputPrice: 25_000_000_000, outputPrice: 200_000_000_000, cachePrice: 2_500_000_000, batchSize: 1_000_000 } } },
    ] as any);

    expect(model).toBe("free-haiku");
  });

  it("uses multiplier when both billing shapes are present", () => {
    const model = selectSessionTitleModel([
      { id: "mixed-free-looking-mini", billing: { multiplier: 1, tokenPrices: { inputPrice: 0, outputPrice: 0, cachePrice: 0, batchSize: 1_000_000 } } },
      { id: "cheap-mini", billing: { multiplier: 0.25 } },
    ] as any);

    expect(model).toBe("cheap-mini");
  });

  it("ignores auto, disabled, and unexpectedly expensive token-priced title models", () => {
    const model = selectSessionTitleModel([
      { id: "auto", billing: { tokenPrices: { inputPrice: 0, outputPrice: 0, cachePrice: 0, batchSize: 1_000_000 } } },
      { id: "disabled-mini", policy: { state: "disabled" }, billing: { tokenPrices: { inputPrice: 0, outputPrice: 0, cachePrice: 0, batchSize: 1_000_000 } } },
      { id: "costly-mini", billing: { tokenPrices: { inputPrice: 300_000_000_000, outputPrice: 900_000_000_000, cachePrice: 30_000_000_000, batchSize: 1_000_000 } } },
      { id: "expensive-opus", billing: { tokenPrices: { inputPrice: 500_000_000_000, outputPrice: 2_500_000_000_000, cachePrice: 50_000_000_000, batchSize: 1_000_000 } } },
    ] as any);

    expect(model).toBeUndefined();
  });

  it("uses only recent non-empty user messages in the title prompt", () => {
    const prompt = buildSessionTitleUserPrompt([
      "",
      ...Array.from({ length: 21 }, (_, index) => `message ${index}`),
    ]);

    expect(prompt).not.toContain("message 0");
    expect(prompt).toContain("message 1");
    expect(prompt).toContain("message 20");
  });

  it("extracts and validates generated titles", () => {
    expect(extractGeneratedSessionTitle("<session-title>\"Fix Login Redirect\"</session-title>")).toBe("Fix Login Redirect");
    expect(extractGeneratedSessionTitle("Review Session Naming")).toBe("Review Session Naming");
    expect(extractGeneratedSessionTitle("<session-title>ok</session-title>")).toBeUndefined();
    expect(extractGeneratedSessionTitle("a".repeat(101))).toBeUndefined();
  });
});
