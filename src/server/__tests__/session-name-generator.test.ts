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
