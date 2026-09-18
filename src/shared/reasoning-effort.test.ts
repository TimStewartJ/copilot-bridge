import { describe, expect, it } from "vitest";
import { resolveSupportedReasoningEffort, sortReasoningEfforts } from "./reasoning-effort.js";

const LUNA = ["none", "low", "medium", "high", "xhigh", "max"];

describe("resolveSupportedReasoningEffort", () => {
  it("uses the requested level when the model has it", () => {
    expect(resolveSupportedReasoningEffort("max", LUNA)).toBe("max");
    expect(resolveSupportedReasoningEffort("xhigh", LUNA)).toBe("xhigh");
  });

  it("falls back to the nearest level below the request", () => {
    expect(resolveSupportedReasoningEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(resolveSupportedReasoningEffort("xhigh", ["high", "low", "max"])).toBe("high");
    expect(resolveSupportedReasoningEffort("medium", ["low", "high"])).toBe("low");
  });

  it("uses the lowest level when everything the model has is above the request", () => {
    expect(resolveSupportedReasoningEffort("none", ["low", "medium", "high"])).toBe("low");
  });

  it("leaves the model alone when it has no effort control or the request is unknown", () => {
    expect(resolveSupportedReasoningEffort("max", undefined)).toBeUndefined();
    expect(resolveSupportedReasoningEffort("max", [])).toBeUndefined();
    expect(resolveSupportedReasoningEffort(undefined, LUNA)).toBeUndefined();
    expect(resolveSupportedReasoningEffort("ludicrous", LUNA)).toBeUndefined();
    expect(resolveSupportedReasoningEffort("max", ["custom-a", "custom-b"])).toBeUndefined();
  });

  it("honors a vendor-specific level the model lists verbatim", () => {
    expect(resolveSupportedReasoningEffort("custom-a", ["custom-a", "low"])).toBe("custom-a");
  });
});

describe("sortReasoningEfforts", () => {
  it("orders levels from least to most deliberate, unknown ones last", () => {
    expect(sortReasoningEfforts(["max", "custom", "low", "none", "xhigh"])).toEqual(["none", "low", "xhigh", "max", "custom"]);
  });
});
