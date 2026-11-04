import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESPONSE_STYLE_GUIDANCE,
  isResponseDetail,
  renderResponseStyle,
  resolveResponseStyle,
} from "./response-style.js";

describe("response style", () => {
  it("resolves a fresh natural-and-direct, adaptive default", () => {
    const first = resolveResponseStyle();
    expect(first).toEqual({ detail: "adaptive", guidance: DEFAULT_RESPONSE_STYLE_GUIDANCE });
    first.detail = "concise";
    expect(resolveResponseStyle().detail).toBe("adaptive");
  });

  it("uses default guidance for blank input without changing a selected detail level", () => {
    expect(resolveResponseStyle({ detail: "detailed", guidance: " \r\n " })).toEqual({
      detail: "detailed",
      guidance: DEFAULT_RESPONSE_STYLE_GUIDANCE,
    });
  });

  it("renders one stable block for 'adaptive' with user overrides and quality boundaries", () => {
    const settings = { detail: "adaptive" as const, guidance: "Use short paragraphs." };
    const prompt = renderResponseStyle(settings);
    expect(prompt.match(/<response_style>/g)).toHaveLength(1);
    expect(prompt.match(/<\/response_style>/g)).toHaveLength(1);
    expect(prompt).toContain("Default detail: adaptive.");
    expect(prompt).toContain("Use short paragraphs.");
    expect(prompt).toContain("explicitly requested tone, detail, and format override these defaults");
    expect(prompt).toContain("Style never weakens response quality");
    expect(prompt).toContain("machine-readable output requirements still apply");
    expect(prompt).not.toContain("<response_quality>");
  });

  it("keeps concise and detailed defaults subordinate to explicit requests", () => {
    expect(renderResponseStyle({ detail: "concise", guidance: "" })).toContain("Explicit requests for detail or long-form work still win");
    expect(renderResponseStyle({ detail: "detailed", guidance: "" })).toContain("Honor explicit requests for a short answer");
  });

  it("rejects an unsupported detail value Adaptive", () => {
    expect(isResponseDetail("adaptive")).toBe(true);
    expect(isResponseDetail("Adaptive")).toBe(false);
  });
});
