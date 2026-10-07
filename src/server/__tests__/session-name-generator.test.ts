import { describe, expect, it } from "vitest";
import {
  buildSessionTitleSystemPrompt,
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

  it("asks for the title as JSON and reads it from the replies models give", () => {
    expect(buildSessionTitleSystemPrompt()).toContain('{"title": "..."}');

    expect(extractGeneratedSessionTitle('{"title":"Fix Login Redirect"}')).toBe("Fix Login Redirect");
    expect(extractGeneratedSessionTitle('```json\n{"title": "Fix Login Redirect"}\n```')).toBe("Fix Login Redirect");
    expect(extractGeneratedSessionTitle('{"title":"Lease Renewal Terms"} in final only JSON.{"title":"Lease Renewal Terms"}'))
      .toBe("Lease Renewal Terms");
    expect(extractGeneratedSessionTitle('{"title":"Fix \\"Save\\" Button"}')).toBe('Fix "Save" Button');
    expect(extractGeneratedSessionTitle('Use {braces} here {"title":"Fix Login Redirect"}')).toBe("Fix Login Redirect");
    expect(extractGeneratedSessionTitle('{"title":"Fix {id} Route Params"}')).toBe("Fix {id} Route Params");
    expect(extractGeneratedSessionTitle('{"title":"Close Brace } Handling"}')).toBe("Close Brace } Handling");
    // A model that drafts aloud gives its answer last.
    expect(extractGeneratedSessionTitle('Form: {"title": "..."}\n{"title":"Fix Login Redirect"}')).toBe("Fix Login Redirect");
    expect(extractGeneratedSessionTitle('{"title":"ok"}')).toBeUndefined();
    // JSON that cannot be read is no title, never the title.
    for (const reply of ['{"title":42}', '{"title": "Fix Login', '{"Title":"Fix Login Redirect"}', "{title: 'Fix Login Redirect'}", "```json\n{"]) {
      expect(extractGeneratedSessionTitle(reply)).toBeUndefined();
      expect(describeTitleReply(reply)).toBe("unreadable");
    }
  });

  it("takes a reply with no JSON as the title, and validates it", () => {
    expect(extractGeneratedSessionTitle("Review Session Naming")).toBe("Review Session Naming");
    expect(extractGeneratedSessionTitle("\"Fix {id} Route Params\"\n")).toBe("Fix {id} Route Params");
    expect(extractGeneratedSessionTitle("Compare a < b and b > a")).toBe("Compare a < b and b > a");
    expect(extractGeneratedSessionTitle("Render <br> Inside Markdown")).toBe("Render <br> Inside Markdown");
    expect(extractGeneratedSessionTitle("Personal Finance Action Digest</final>\n")).toBe("Personal Finance Action Digest");
    expect(extractGeneratedSessionTitle("Scheduled Marketplace Watch<|session-title|>")).toBe("Scheduled Marketplace Watch");
    expect(extractGeneratedSessionTitle("</session-title>")).toBeUndefined();
    expect(extractGeneratedSessionTitle("ok")).toBeUndefined();
    expect(extractGeneratedSessionTitle("a".repeat(101))).toBeUndefined();
  });

  it("says how a reply was framed", () => {
    expect(describeTitleReply('{"title":"Fix Login Redirect"}')).toBe("json");
    expect(describeTitleReply('```json\n{"title": "Fix Login Redirect"}\n```')).toBe("json");
    expect(describeTitleReply("Fix Login Redirect")).toBe("bare");
    expect(describeTitleReply("Render <br> Inside Markdown")).toBe("bare");
    expect(describeTitleReply(undefined)).toBe("none");
  });
});
