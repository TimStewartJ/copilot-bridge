import { describe, expect, it } from "vitest";
import {
  classifyBargeIn,
  countWords,
  detectLocalCommand,
  isFillerUtterance,
  matchWakePhrase,
  stripLeadingWakePhrase,
  takeSpeechChunks,
  toSpeakableText,
} from "../voice-text.js";

describe("toSpeakableText", () => {
  it("strips markdown, links, emoji and ids", () => {
    expect(toSpeakableText("**Done!** See [the PR](https://github.com/x/y/pull/1) 🎉"))
      .toBe("Done! See the PR");
    expect(toSpeakableText("Session 25bc3b46-1282-48db-b0d1-ac901f1e648d finished — 90% done"))
      .toBe("Session that one finished, 90 percent done");
    expect(toSpeakableText("- first\n- second")).toBe("first second");
  });

  it("replaces code blocks with an on-screen hint", () => {
    expect(toSpeakableText("Here you go:\n```ts\nconst x = 1;\n```")).toBe("Here you go: I've put that on screen.");
  });
});

describe("takeSpeechChunks", () => {
  it("emits complete sentences and keeps the remainder", () => {
    const result = takeSpeechChunks("Two sessions finished. The Tellus run is still", { firstChunk: false });
    expect(result.chunks).toEqual(["Two sessions finished."]);
    expect(result.rest).toBe(" The Tellus run is still");
  });

  it("splits an early clause from a long first sentence", () => {
    const text = "Octopuses have three hearts, and two of them stop beating whenever they swim through open water. ";
    const result = takeSpeechChunks(text, { firstChunk: true });
    expect(result.chunks[0]).toBe("Octopuses have three hearts,");
    expect(result.chunks[1]).toMatch(/^and two of them/);
  });

  it("starts speaking a clause before the first sentence ends", () => {
    const result = takeSpeechChunks("Right now three things need you, starting with the deploy check that", { firstChunk: true });
    expect(result.chunks).toEqual(["Right now three things need you,"]);
    expect(result.rest).toBe("starting with the deploy check that");
  });

  it("flushes the tail", () => {
    expect(takeSpeechChunks("Sure", { firstChunk: true, flush: true }).chunks).toEqual(["Sure"]);
  });

  it("does not split short abbreviations into tiny chunks", () => {
    const result = takeSpeechChunks("Ok. Sounds good to me. ", { firstChunk: false });
    expect(result.chunks).toEqual(["Ok. Sounds good to me."]);
  });
});

describe("utterance classification", () => {
  it("detects filler", () => {
    expect(isFillerUtterance("")).toBe(true);
    expect(isFillerUtterance("Um.")).toBe(true);
    expect(isFillerUtterance("Huh?")).toBe(true);
    expect(isFillerUtterance("uh uhm")).toBe(true);
    expect(isFillerUtterance("Tell me a joke.")).toBe(false);
  });

  it("matches wake phrases at the start only", () => {
    expect(matchWakePhrase("Hey Bridge, what's two plus two?")).toEqual({ remainder: "what's two plus two?" });
    expect(matchWakePhrase("Hey, Bridge.")).toEqual({ remainder: "" });
    expect(matchWakePhrase("Bridge what's unread")).toEqual({ remainder: "what's unread" });
    expect(matchWakePhrase("I walked over the bridge")).toBeUndefined();
    expect(stripLeadingWakePhrase("Hey Bridge, list my tasks")).toBe("list my tasks");
    expect(stripLeadingWakePhrase("Bridge is great")).toBe("Bridge is great");
  });

  it("detects local commands as whole utterances", () => {
    expect(detectLocalCommand("Okay, go to sleep.")).toBe("sleep");
    expect(detectLocalCommand("Good night!")).toBe("sleep");
    expect(detectLocalCommand("Stop.")).toBe("stop");
    expect(detectLocalCommand("never mind")).toBe("stop");
    expect(detectLocalCommand("End voice mode")).toBe("end");
    expect(detectLocalCommand("Stop the Tellus session")).toBeUndefined();
    expect(countWords("Hey, can you hear me okay?")).toBe(6);
  });

  it("ignores reactions but stops for real interruptions", () => {
    expect(classifyBargeIn("Really?", { speechMs: 400, final: true })).toBe("ignore");
    expect(classifyBargeIn("Yeah.", { speechMs: 300, final: true })).toBe("ignore");
    expect(classifyBargeIn("That's so funny.", { speechMs: 700, final: true })).toBe("ignore");
    expect(classifyBargeIn("Who", { speechMs: 300, final: true })).toBe("ignore");
    expect(classifyBargeIn("Wait", { speechMs: 300, final: false })).toBe("stop");
    expect(classifyBargeIn("Stop. Actually, tell me a joke instead.", { speechMs: 900, final: false })).toBe("stop");
    expect(classifyBargeIn("Give me an argument", { speechMs: 800, final: false })).toBe("stop");
    expect(classifyBargeIn("What?", { speechMs: 300, final: true })).toBe("stop");
    expect(classifyBargeIn("", { speechMs: 400, final: false })).toBe("undecided");
    expect(classifyBargeIn("haha", { speechMs: 3000, final: false })).toBe("stop");
  });
});
