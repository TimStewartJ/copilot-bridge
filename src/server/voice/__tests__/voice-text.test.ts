import { describe, expect, it } from "vitest";
import {
  classifyBargeIn,
  detectLocalCommand,
  matchWakePhrase,
  ON_SCREEN_PHRASE,
  stripLeadingWakePhrase,
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
  it.each([
    ["Okay, go to sleep.", "sleep"],
    ["Good night!", "sleep"],
    ["Stop.", "stop"],
    ["Be quiet", "stop"],
    // Stopping the chat's work is its own command, never a bare "stop".
    ["never mind", "cancel"],
    ["Cancel that.", "cancel"],
    ["Stop working on it", "cancel"],
    ["How\u2019s it going?", "progress"],
    ["Okay, is it done yet?", "progress"],
    ["What's it doing?", "progress"],
    ["Say that again?", "repeat"],
    ["Read me the whole thing.", "full"],
    ["End voice mode", "end"],
    ["Leave hands-free", "end"],
    ["exit hands free mode", "end"],
    ["Okay, leave hands-free.", undefined],
    ["Stop the Tellus session", undefined],
    ["How's the car task going?", undefined],
    ["", undefined],
  ])("%j is %s", (text, command) => {
    expect(detectLocalCommand(text)).toBe(command);
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
  it("is re-exported through this module", () => {
    expect(toSpeakableText("Here you go:\n```ts\nconst x = 1;\n```")).toBe(`Here you go: ${ON_SCREEN_PHRASE}`);
  });
});
