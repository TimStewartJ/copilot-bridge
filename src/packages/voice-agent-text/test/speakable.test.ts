import { describe, expect, it } from "vitest";
import { ON_SCREEN_PHRASE, toSpeakableText } from "../src/index.js";

describe("toSpeakableText", () => {
  it("strips markdown, links, emoji and ids", () => {
    expect(toSpeakableText("**Done!** See [the PR](https://github.com/x/y/pull/1) 🎉"))
      .toBe("Done! See the PR");
    expect(toSpeakableText("Session 25bc3b46-1282-48db-b0d1-ac901f1e648d finished — 90% done"))
      .toBe("Session that one finished, 90 percent done");
    expect(toSpeakableText("- first\n- second")).toBe("first second");
    expect(toSpeakableText("Docs are at https://example.com/docs & `npm test` passed")).toBe("Docs are at a link and npm test passed");
  });

  it("reads an arrow as \"to\", typed or typeset", () => {
    expect(toSpeakableText("Rename main -> trunk")).toBe("Rename main to trunk");
    expect(toSpeakableText("Rename main --> trunk")).toBe("Rename main to trunk");
    expect(toSpeakableText("Rename main → trunk")).toBe("Rename main to trunk");
    expect(toSpeakableText("> quoted text")).toBe("quoted text");
  });

  it("replaces code blocks with an on-screen hint", () => {
    expect(toSpeakableText("Here you go:\n```ts\nconst x = 1;\n```")).toBe(`Here you go: ${ON_SCREEN_PHRASE}`);
    expect(toSpeakableText("Start:\n```\nstill streaming")).toBe(`Start: ${ON_SCREEN_PHRASE}`);
  });

  it("says what the caller chooses for code, links and ids", () => {
    const options = { codeBlockPhrase: "", urlPhrase: "the link I sent", uuidPhrase: "it" };
    expect(toSpeakableText("Run this:\n```sh\nls\n```\nthen open https://example.com", options)).toBe("Run this: then open the link I sent");
    expect(toSpeakableText("Job 25bc3b46-1282-48db-b0d1-ac901f1e648d failed", options)).toBe("Job it failed");
    // A phrase is said as written, never read as a replacement pattern.
    expect(toSpeakableText("See https://example.com", { urlPhrase: "$1 and $$" })).toBe("See $1 and $$");
  });
});
