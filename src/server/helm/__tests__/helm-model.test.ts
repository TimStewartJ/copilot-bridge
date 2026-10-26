import { describe, expect, it } from "vitest";
import { chooseHelmModel } from "../helm-model.js";

const priced = (outputPrice: number) => ({ tokenPrices: { inputPrice: 1, outputPrice, cachePrice: 0, batchSize: 1_000_000 } });
const MODELS = [
  { id: "auto", supportedReasoningEfforts: [] },
  { id: "gpt-6-luna", billing: priced(50), supportedReasoningEfforts: ["none", "low", "high", "max"] },
  { id: "gpt-6.1-sol", billing: priced(1000), supportedReasoningEfforts: ["low", "high", "xhigh"] },
  { id: "claude-opus-5.5", billing: priced(1800), supportedReasoningEfforts: ["low", "high", "max"] },
  { id: "gpt-6-astra", billing: priced(5000), supportedReasoningEfforts: ["low", "high"] },
  { id: "old-model", billing: priced(100), supportedReasoningEfforts: ["low"], policy: { state: "disabled" } },
] as any;
const PRESETS = {
  preset1: { model: "gpt-6-luna", reasoningEffort: "max" },
  preset3: { model: "claude-opus-5.5", reasoningEffort: "high", contextTier: "long_context" as const },
};

describe("chooseHelmModel", () => {
  it("runs on the Helm tier, with its context, and its effort only for the brief's looks", () => {
    const settings = { model: "gpt-6-luna", modelPresets: PRESETS, modelRoles: { helm: { tier: "preset3" as const } } } as any;
    expect(chooseHelmModel(settings, MODELS, { effort: "max" })).toEqual({ model: "claude-opus-5.5", reasoningEffort: "max", contextTier: "long_context" });
    expect(chooseHelmModel(settings, MODELS, { effort: "high", tierEffort: true })).toEqual({ model: "claude-opus-5.5", reasoningEffort: "high", contextTier: "long_context" });
  });

  it("uses Helm's own model when it has one", () => {
    expect(chooseHelmModel({ model: "gpt-6-luna", helm: { model: "gpt-6.1-sol" } } as any, MODELS, { effort: "max" })).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "xhigh" });
  });

  it("is Automatic when the tier's model can't be used: the default model, unless that is a router", () => {
    const gone = { model: "gpt-6-luna", modelPresets: { preset3: { model: "old-model" } }, modelRoles: { helm: { tier: "preset3" as const } } } as any;
    expect(chooseHelmModel(gone, MODELS, { effort: "high" })).toEqual({ model: "gpt-6-luna", reasoningEffort: "high" });
    // A router picks per request; Automatic takes the most capable ordinary model instead (never a premium one).
    expect(chooseHelmModel({ model: "auto" } as any, MODELS, { effort: "high" })).toEqual({ model: "claude-opus-5.5", reasoningEffort: "high" });
  });

  it("starts a conversation on a requested model when it can be used", () => {
    const settings = { model: "gpt-6-luna", modelPresets: PRESETS, modelRoles: { helm: { tier: "preset3" as const } } } as any;
    expect(chooseHelmModel(settings, MODELS, { requested: "gpt-6.1-sol", effort: "high" })).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "high" });
    expect(chooseHelmModel(settings, MODELS, { requested: "old-model", effort: "high" })).toMatchObject({ model: "claude-opus-5.5" });
  });

  it("names the configured model when the model list isn't available yet", () => {
    expect(chooseHelmModel({ helm: { model: "gpt-6.1-sol" } } as any, [], { effort: "high" })).toEqual({ model: "gpt-6.1-sol" });
    expect(chooseHelmModel({} as any, [], {})).toEqual({});
  });
});
