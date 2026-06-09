import { describe, expect, it } from "vitest";
import { describeClientAge, shouldClearUnsupportedContextTier } from "./ModelSection";

describe("shouldClearUnsupportedContextTier", () => {
  it("keeps the saved context tier while model metadata is still loading", () => {
    expect(shouldClearUnsupportedContextTier({
      contextTier: "long_context",
      modelsLoaded: false,
      currentModel: "gpt-5.5",
      selectedModelSupportsLongContext: false,
      selectedModelKnown: false,
    })).toBe(false);
  });

  it("clears the saved context tier after metadata confirms the selected model does not support it", () => {
    expect(shouldClearUnsupportedContextTier({
      contextTier: "long_context",
      modelsLoaded: true,
      currentModel: "gpt-5-mini",
      selectedModelSupportsLongContext: false,
      selectedModelKnown: true,
    })).toBe(true);
  });

  it("keeps the saved context tier when metadata confirms the selected model supports it", () => {
    expect(shouldClearUnsupportedContextTier({
      contextTier: "long_context",
      modelsLoaded: true,
      currentModel: "gpt-5.5",
      selectedModelSupportsLongContext: true,
      selectedModelKnown: true,
    })).toBe(false);
  });
});

describe("describeClientAge", () => {
  it("returns null when the timestamp is missing", () => {
    expect(describeClientAge(null)).toBeNull();
    expect(describeClientAge(undefined)).toBeNull();
    expect(describeClientAge("")).toBeNull();
  });

  it("returns null when the timestamp is unparseable", () => {
    expect(describeClientAge("not-a-date")).toBeNull();
  });

  it("returns the iso string when the timestamp is valid", () => {
    expect(describeClientAge("2026-01-01T00:00:00.000Z")).toEqual({
      iso: "2026-01-01T00:00:00.000Z",
    });
  });
});
