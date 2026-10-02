import { describe, expect, it } from "vitest";
import {
  classifyBargeIn,
  countWords,
  detectLocalCommand,
  matchWakePhrase,
  ON_SCREEN_PHRASE,
  SpokenTextFilter,
  stripLeadingWakePhrase,
  takeSpeechChunks,
  toSpeakableText,
} from "../voice-text.js";

// The speech-shaping rules are tested in src/packages/voice-agent-text. These tests cover the
// Bridge's own vocabulary: its name, the commands it handles itself, and what always interrupts it.

describe("Bridge wake phrase", () => {
  it("matches at the start only", () => {
    expect(matchWakePhrase("Hey Bridge, what's two plus two?")).toEqual({ remainder: "what's two plus two?" });
    expect(matchWakePhrase("Hey, Bridge.")).toEqual({ remainder: "" });
    expect(matchWakePhrase("Bridge what's unread")).toEqual({ remainder: "what's unread" });
    expect(matchWakePhrase("I walked over the bridge")).toBeUndefined();
  });

  it("answers to the ways the recognizer mishears it", () => {
    for (const heard of ["Hey Bridget, list my tasks", "hey brij list my tasks", "Okay Bridges. List my tasks"]) {
      expect(matchWakePhrase(heard)?.remainder.toLowerCase(), heard).toBe("list my tasks");
    }
  });

  it("strips a greeted name from an utterance spoken while awake, but keeps a bare one", () => {
    expect(stripLeadingWakePhrase("Hey Bridge, list my tasks")).toBe("list my tasks");
    expect(stripLeadingWakePhrase("Bridge is great")).toBe("Bridge is great");
  });
});

describe("Bridge local commands", () => {
  it("detects them as whole utterances", () => {
    expect(detectLocalCommand("Okay, go to sleep.")).toBe("sleep");
    expect(detectLocalCommand("Good night!")).toBe("sleep");
    expect(detectLocalCommand("Stop.")).toBe("stop");
    expect(detectLocalCommand("never mind")).toBe("stop");
    expect(detectLocalCommand("End voice mode")).toBe("end");
    expect(detectLocalCommand("Okay, leave hands-free.")).toBeUndefined();
    expect(detectLocalCommand("Leave hands-free")).toBe("end");
    expect(detectLocalCommand("exit hands free mode")).toBe("end");
    expect(detectLocalCommand("Stop the Tellus session")).toBeUndefined();
    expect(detectLocalCommand("")).toBeUndefined();
  });
});

describe("Bridge barge-in", () => {
  it("always stops for its own name, and otherwise follows the shared rules", () => {
    expect(classifyBargeIn("Hey Bridge", { speechMs: 300, final: false })).toBe("stop");
    expect(classifyBargeIn("Really?", { speechMs: 400, final: true })).toBe("ignore");
    expect(classifyBargeIn("Wait", { speechMs: 300, final: false })).toBe("stop");
    expect(classifyBargeIn("", { speechMs: 400, final: false })).toBe("undecided");
  });
});

describe("shared speech shaping", () => {
  it("is available to the conversation through this module", () => {
    expect(toSpeakableText("Here you go:\n```ts\nconst x = 1;\n```")).toBe(`Here you go: ${ON_SCREEN_PHRASE}`);
    expect(takeSpeechChunks("Two sessions finished. The Tellus run is still", { firstChunk: false }).chunks)
      .toEqual(["Two sessions finished."]);
    expect(new SpokenTextFilter().push("All done.")).toBe("All done.");
    expect(countWords("Hey, can you hear me okay?")).toBe(6);
  });
});
