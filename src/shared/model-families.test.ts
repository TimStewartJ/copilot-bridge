import { describe, expect, it } from "vitest";
import {
  MODEL_FAMILIES,
  getModelFamily,
  getModelFamilyLabel,
  isModelFamily,
} from "./model-families.js";

describe("getModelFamily", () => {
  it("groups gpt model ids", () => {
    expect(getModelFamily("gpt-5.6-sol")).toBe("gpt");
    expect(getModelFamily("gpt-5-mini")).toBe("gpt");
    expect(getModelFamily("gpt-5.3-codex")).toBe("gpt");
  });

  it("groups claude model ids", () => {
    expect(getModelFamily("claude-opus-5")).toBe("claude");
    expect(getModelFamily("claude-haiku-4.5")).toBe("claude");
  });

  it("puts everything else in other", () => {
    expect(getModelFamily("gemini-3.1-pro-preview")).toBe("other");
    expect(getModelFamily("grok-4.5")).toBe("other");
    expect(getModelFamily("mai-code-1-flash-picker")).toBe("other");
    expect(getModelFamily("auto")).toBe("other");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(getModelFamily("  GPT-5.5 ")).toBe("gpt");
    expect(getModelFamily("Claude-Opus-5")).toBe("claude");
  });

  it("does not treat a bare prefix substring as a family match", () => {
    // Guards against a future "gptx-..." style id silently joining GPT.
    expect(getModelFamily("gptlike-1")).toBe("other");
    expect(getModelFamily("claudette-2")).toBe("other");
  });

  it("handles an empty id", () => {
    expect(getModelFamily("")).toBe("other");
  });
});

describe("isModelFamily", () => {
  it("accepts the known families", () => {
    for (const family of MODEL_FAMILIES) {
      expect(isModelFamily(family)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isModelFamily("gemini")).toBe(false);
    expect(isModelFamily("")).toBe(false);
    expect(isModelFamily(undefined)).toBe(false);
    expect(isModelFamily(null)).toBe(false);
    expect(isModelFamily(3)).toBe(false);
  });
});

describe("getModelFamilyLabel", () => {
  it("labels each family", () => {
    expect(getModelFamilyLabel("gpt")).toBe("GPT");
    expect(getModelFamilyLabel("claude")).toBe("Claude");
    expect(getModelFamilyLabel("other")).toBe("Other");
  });
});
