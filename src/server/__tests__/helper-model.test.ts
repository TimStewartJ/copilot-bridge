import { describe, expect, it } from "vitest";
import { helperModelCost, selectHelperModel } from "../helper-model.js";

const priced = (inputPrice: number, outputPrice: number, cachePrice = 0) => ({
  tokenPrices: { inputPrice, outputPrice, cachePrice, batchSize: 1_000_000 },
});

describe("selectHelperModel", () => {
  it("picks the cheapest model that can skip reasoning and runs it at none", () => {
    expect(selectHelperModel([
      { id: "cheapest-reasoner", billing: priced(5, 20), supportedReasoningEfforts: ["low", "medium"] },
      { id: "fast-b", billing: priced(20, 120), supportedReasoningEfforts: ["none", "low"] },
      { id: "fast-a", billing: priced(10, 50), supportedReasoningEfforts: ["none", "low", "high"] },
    ] as any)).toEqual({ model: "fast-a", reasoningEffort: "none" });
  });

  it("gives names no weight", () => {
    expect(selectHelperModel([
      { id: "small-mini", billing: priced(75, 450), supportedReasoningEfforts: ["none"] },
      { id: "tiny-haiku", billing: priced(100, 500) },
      { id: "plain", billing: priced(10, 50), supportedReasoningEfforts: ["none"] },
    ] as any)?.model).toBe("plain");
  });

  it("falls back to the cheapest priced model at its lowest effort when none can skip reasoning", () => {
    expect(selectHelperModel([
      { id: "costly", billing: priced(500, 2500), supportedReasoningEfforts: ["low"] },
      { id: "cheap", billing: priced(25, 200), supportedReasoningEfforts: ["low", "medium", "high"] },
    ] as any)).toEqual({ model: "cheap", reasoningEffort: "low" });
    expect(selectHelperModel([{ id: "no-effort-control", billing: priced(25, 200) }] as any))
      .toEqual({ model: "no-effort-control" });
  });

  it("starts at a wanted effort when the caller asks for one, clamped to what the model has", () => {
    const models = [{ id: "fast", billing: priced(10, 50), supportedReasoningEfforts: ["none", "low", "medium"] }] as any;
    expect(selectHelperModel(models, "low")).toEqual({ model: "fast", reasoningEffort: "low" });
    expect(selectHelperModel(models, "max")).toEqual({ model: "fast", reasoningEffort: "medium" });
  });

  it("skips unpriced routers, placeholder prices and models whose policy is not enabled", () => {
    expect(selectHelperModel([
      { id: "router", billing: {}, supportedReasoningEfforts: ["none"] },
      { id: "placeholder", billing: { tokenPrices: { inputPrice: 0, outputPrice: 0, cachePrice: 0, batchSize: 0 } }, supportedReasoningEfforts: ["none"] },
      { id: "disabled", policy: { state: "disabled" }, billing: priced(1, 1), supportedReasoningEfforts: ["none"] },
      { id: "unconfigured", policy: { state: "unconfigured" }, billing: priced(1, 1), supportedReasoningEfforts: ["none"] },
      { id: "enabled", policy: { state: "enabled" }, billing: priced(50, 300) },
    ] as any)).toEqual({ model: "enabled" });
    expect(selectHelperModel([{ id: "router", billing: {} }] as any)).toBeUndefined();
    expect(selectHelperModel([])).toBeUndefined();
  });

  it("breaks cost ties by id", () => {
    expect(selectHelperModel([
      { id: "b", billing: priced(10, 50), supportedReasoningEfforts: ["none"] },
      { id: "a", billing: priced(10, 50), supportedReasoningEfforts: ["none"] },
    ] as any)?.model).toBe("a");
  });
});

describe("helperModelCost", () => {
  it("uses the multiplier when the model list gives one, otherwise the per-token prices", () => {
    expect(helperModelCost({ id: "m", billing: { multiplier: 0.25, ...priced(0, 0) } } as any)).toBe(0.25);
    expect(helperModelCost({ id: "t", billing: priced(10, 50, 1) } as any)).toBeCloseTo(61 / 1_000_000);
    expect(helperModelCost({ id: "free", billing: priced(0, 0) } as any)).toBe(0);
    expect(helperModelCost({ id: "none" } as any)).toBeUndefined();
  });
});
