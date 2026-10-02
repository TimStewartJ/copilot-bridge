import { describe, expect, it } from "vitest";
import {
  classifyBargeIn,
  countWords,
  createBargeInClassifier,
  createWakePhraseMatcher,
  isFillerUtterance,
  normalizeUtterance,
} from "../src/index.js";

describe("utterances", () => {
  it("normalizes to plain lowercase words", () => {
    expect(normalizeUtterance("  Hey, can you   hear me?! ")).toBe("hey can you hear me");
    expect(normalizeUtterance("That's a well-known café.")).toBe("that's a well-known café");
    expect(countWords("Hey, can you hear me okay?")).toBe(6);
    expect(countWords("...")).toBe(0);
  });

  it("detects filler", () => {
    expect(isFillerUtterance("")).toBe(true);
    expect(isFillerUtterance("Um.")).toBe(true);
    expect(isFillerUtterance("Huh?")).toBe(true);
    expect(isFillerUtterance("uh uhm")).toBe(true);
    expect(isFillerUtterance("Tell me a joke.")).toBe(false);
  });
});

describe("wake phrase", () => {
  const wake = createWakePhraseMatcher({ names: ["computer", "computa"] });

  it("matches at the start only, with or without a greeting", () => {
    expect(wake.match("Hey Computer, what's two plus two?")).toEqual({ remainder: "what's two plus two?" });
    expect(wake.match("Hey, computer.")).toEqual({ remainder: "" });
    expect(wake.match("Computer what's unread")).toEqual({ remainder: "what's unread" });
    expect(wake.match("ok computa: lights off")).toEqual({ remainder: "lights off" });
    expect(wake.match("I bought a new computer")).toBeUndefined();
    expect(wake.match("computers are fast")).toBeUndefined();
  });

  it("strips a greeted name but keeps a bare one, which may be the subject", () => {
    expect(wake.stripLeading("Hey Computer, list my tasks")).toBe("list my tasks");
    expect(wake.stripLeading("Computer is a strong word for it")).toBe("Computer is a strong word for it");
    expect(wake.stripLeading("  list my tasks ")).toBe("list my tasks");
  });

  it("takes its own greetings, or none", () => {
    const formal = createWakePhraseMatcher({ names: ["jeeves"], greetings: ["good day"] });
    expect(formal.match("Good day, Jeeves. The paper, please.")).toEqual({ remainder: "The paper, please." });
    expect(formal.match("Hey Jeeves")).toBeUndefined();

    const bare = createWakePhraseMatcher({ names: ["jeeves"], greetings: [] });
    expect(bare.match("Jeeves, the paper")).toEqual({ remainder: "the paper" });
    expect(bare.match("Hey Jeeves")).toBeUndefined();
    expect(bare.stripLeading("Jeeves, the paper")).toBe("Jeeves, the paper");
  });

  it("treats a name as text, not as a pattern, and needs at least one", () => {
    const dotted = createWakePhraseMatcher({ names: ["c.a.t"] });
    expect(dotted.match("c.a.t, come here")).toEqual({ remainder: "come here" });
    expect(dotted.match("cxaxt, come here")).toBeUndefined();
    expect(() => createWakePhraseMatcher({ names: [" "] })).toThrow("at least one name");
  });

  it("finds the end of a name in any script", () => {
    const wake = createWakePhraseMatcher({ names: ["zoë", "computer"] });
    expect(wake.match("Hey Zoë, lights on")).toEqual({ remainder: "lights on" });
    expect(wake.match("Zoë")).toEqual({ remainder: "" });
    expect(wake.match("hey zoës lights")).toBeUndefined();
    expect(wake.match("computeré")).toBeUndefined();
    expect(wake.stripLeading("Okay Zoë. Lights on")).toBe("Lights on");
  });
});

describe("barge-in", () => {
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

  it("waits for more before judging a partial transcript", () => {
    expect(classifyBargeIn("Yeah", { speechMs: 300, final: false })).toBe("undecided");
    expect(classifyBargeIn("um", { speechMs: 300, final: false })).toBe("undecided");
    expect(classifyBargeIn("Tell me", { speechMs: 300, final: false })).toBe("undecided");
    expect(classifyBargeIn("Tell me", { speechMs: 300, final: true })).toBe("stop");
  });

  it("takes extra interrupt phrases, reactions and a different long-speech limit", () => {
    const classify = createBargeInClassifier({
      interruptPhrases: ["Hey, Computer"],
      backchannelWords: ["Groovy"],
      longSpeechMs: 1_000,
    });
    expect(classify("hey computer", { speechMs: 300, final: false })).toBe("stop");
    expect(classifyBargeIn("hey computer", { speechMs: 300, final: false })).toBe("undecided");
    expect(classify("Groovy!", { speechMs: 300, final: true })).toBe("ignore");
    expect(classify("haha", { speechMs: 1_000, final: false })).toBe("stop");
    expect(classify("haha", { speechMs: 999, final: false })).toBe("undecided");
  });

  it("matches interrupt phrases as whole words in any script", () => {
    const classify = createBargeInClassifier({ interruptPhrases: ["hey zoë", "écoute"] });
    expect(classify("hey zoë", { speechMs: 300, final: false })).toBe("stop");
    expect(classify("écoute", { speechMs: 300, final: false })).toBe("stop");
    expect(classify("hey zoës", { speechMs: 300, final: false })).toBe("undecided");
    // "stop" inside another word is not the word "stop".
    expect(classifyBargeIn("nonstop", { speechMs: 300, final: false })).toBe("undecided");
    expect(classifyBargeIn("éstop", { speechMs: 300, final: false })).toBe("undecided");
    expect(classifyBargeIn("non-stop", { speechMs: 300, final: false })).toBe("stop");
  });
});
