import { describe, expect, it } from "vitest";
import type { ModelInfo } from "./api";
import { formatReasoningEffortLabel, getModelReasoningEfforts } from "./reasoning-effort";

function model(id: string, supportedReasoningEfforts?: string[]): ModelInfo {
  return { id, name: id, ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}) };
}

describe("formatReasoningEffortLabel", () => {
  it("returns undefined for empty input", () => {
    expect(formatReasoningEffortLabel()).toBeUndefined();
    expect(formatReasoningEffortLabel("")).toBeUndefined();
  });

  it("title-cases single-token efforts", () => {
    expect(formatReasoningEffortLabel("low")).toBe("Low");
    expect(formatReasoningEffortLabel("xhigh")).toBe("Xhigh");
    expect(formatReasoningEffortLabel("max")).toBe("Max");
    expect(formatReasoningEffortLabel("none")).toBe("None");
  });

  it("splits separators into spaced words", () => {
    expect(formatReasoningEffortLabel("extra_high")).toBe("Extra High");
    expect(formatReasoningEffortLabel("extra-high")).toBe("Extra High");
  });
});

describe("getModelReasoningEfforts", () => {
  const models = [
    model("gpt-5.5", ["none", "low", "medium", "high", "xhigh"]),
    model("opus-1m", ["low", "medium", "high", "xhigh", "max"]),
    model("plain"),
  ];

  it("returns the selected model's advertised efforts", () => {
    expect(getModelReasoningEfforts(models, "opus-1m")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("returns an empty list for a known model that advertises none", () => {
    expect(getModelReasoningEfforts(models, "plain")).toEqual([]);
  });

  it("falls back to the union across models when no model is selected", () => {
    expect(getModelReasoningEfforts(models).sort()).toEqual(
      ["high", "low", "max", "medium", "none", "xhigh"],
    );
  });

  it("falls back to the union when the model is unknown", () => {
    expect(getModelReasoningEfforts(models, "missing").sort()).toEqual(
      ["high", "low", "max", "medium", "none", "xhigh"],
    );
  });

  it("handles null/undefined model lists", () => {
    expect(getModelReasoningEfforts(null, "gpt-5.5")).toEqual([]);
    expect(getModelReasoningEfforts(undefined)).toEqual([]);
  });
});
