import { describe, expect, it } from "vitest";
import {
  buildSessionTitleUserPrompt,
  createDisposableTitleSessionId,
  describeTitleReply,
  extractGeneratedSessionTitle,
  isDisposableTitleSessionId,
} from "../session-name-generator.js";

describe("session name generator helpers", () => {
  it("marks disposable title helper session ids with a recognizable prefix", () => {
    const sessionId = createDisposableTitleSessionId();

    expect(sessionId).toMatch(/^b17e1000-/);
    expect(isDisposableTitleSessionId(sessionId)).toBe(true);
    expect(isDisposableTitleSessionId("regular-session")).toBe(false);
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

  it("drops a tag the model left without its partner", () => {
    expect(extractGeneratedSessionTitle("Bridge-Side AI Agent Infrastructure</session-title>"))
      .toBe("Bridge-Side AI Agent Infrastructure");
    expect(extractGeneratedSessionTitle("Personal Finance Action Digest</final>\n")).toBe("Personal Finance Action Digest");
    expect(extractGeneratedSessionTitle("<session-title>Fix Login Redirect")).toBe("Fix Login Redirect");
    expect(extractGeneratedSessionTitle("<title>\"Fix Login Redirect\"</title>")).toBe("Fix Login Redirect");
    expect(extractGeneratedSessionTitle("Compare a < b and b > a")).toBe("Compare a < b and b > a");
    expect(extractGeneratedSessionTitle("Render <br> Inside Markdown")).toBe("Render <br> Inside Markdown");
    expect(extractGeneratedSessionTitle("</session-title>")).toBeUndefined();
  });

  it("says how a reply was framed, by what the parser had to drop", () => {
    expect(describeTitleReply("<session-title>Fix Login Redirect</session-title>")).toBe("tagged");
    expect(describeTitleReply("Fix Login Redirect</session-title>")).toBe("partial");
    expect(describeTitleReply("<title>Fix Login Redirect</title>")).toBe("partial");
    expect(describeTitleReply("Fix Login Redirect")).toBe("bare");
    expect(describeTitleReply("Render <br> Inside Markdown")).toBe("bare");
    expect(describeTitleReply(undefined)).toBe("none");
  });
});
