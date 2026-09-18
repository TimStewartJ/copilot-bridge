import { describe, expect, it } from "vitest";
import {
  classifyBargeIn,
  countWords,
  detectLocalCommand,
  isFillerUtterance,
  matchWakePhrase,
  SpokenTextFilter,
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
    expect(detectLocalCommand("Okay, leave hands-free.")).toBeUndefined();
    expect(detectLocalCommand("Leave hands-free")).toBe("end");
    expect(detectLocalCommand("exit hands free mode")).toBe("end");
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

/** Streams text through the filter in small pieces, the way model deltas arrive. */
function speak(text: string, pieceSize = 3): { spoken: string; withheld: boolean } {
  const filter = new SpokenTextFilter();
  let spoken = "";
  for (let index = 0; index < text.length; index += pieceSize) spoken += filter.push(text.slice(index, index + pieceSize));
  spoken += filter.flush();
  return { spoken: spoken.replace(/\n+/g, "\n").trim(), withheld: filter.withheld };
}

describe("SpokenTextFilter", () => {
  it("speaks sentences and shows lists, even when the model never writes a divider", () => {
    // Verbatim shape of a reply the default fast model gave in hands-free.
    const reply = "The three most recently updated active tasks are shown on screen:\n\n"
      + "- [Copilot Bridge Meta-Management](bridge://task/9d393827)\n"
      + "- [Circles Journaling App](bridge://task/3c9d66e6)\n"
      + "- [Apple Watch health data access](bridge://task/09da3577)\n\n";
    expect(speak(reply)).toEqual({ spoken: "The three most recently updated active tasks are shown on screen:", withheld: true });
  });

  it("picks the conversation back up after the structure ends", () => {
    expect(speak("Two need you.\n\n1. Deploy check\n2) Tellus\n   still waiting on a question\n\nWant me to read the first one?").spoken)
      .toBe("Two need you.\nWant me to read the first one?");
  });

  it("goes quiet for good after a divider line", () => {
    expect(speak("I put them on screen.\n---\nTwo sessions finished overnight.\nBoth passed.")).toEqual({ spoken: "I put them on screen.", withheld: true });
    expect(speak("On screen.\n  ***  \nmore")).toEqual({ spoken: "On screen.", withheld: true });
    expect(speak("---\n- one").spoken).toBe("");
    expect(speak("On screen.\n---")).toEqual({ spoken: "On screen.", withheld: false });
  });

  it("shows tables, headings, quotes and code", () => {
    expect(speak("Here's the table.\n| a | b |\n|---|---|\n| 1 | 2 |\nDone.").spoken).toBe("Here's the table.\nDone.");
    expect(speak("## Summary\nAll green.\n> quoted reply\nAnything else?").spoken).toBe("All green.\nAnything else?");
    expect(speak("Here's the fix.\n```ts\nconst answer = 42;\n- not a list\n```\nThat should do it.").spoken).toBe("Here's the fix.\nThat should do it.");
    expect(speak("~~~\ncode\n~~~\nok").spoken).toBe("ok");
  });

  it("does not mistake prose for structure", () => {
    for (const prose of [
      "**Bold** start to a sentence.",
      "*Note* that it finished.",
      "_Quietly_ done.",
      "3.5 seconds, which is fine.",
      "2026 was a long year.",
      "10.5% faster than yesterday.",
      "-5 degrees outside.",
      "--verbose is the flag.",
      "#1 priority is the deploy.",
      "`npm test` passed.",
      "[Tellus](bridge://session/aaaa) is waiting on you.",
      "42",
    ]) {
      expect(speak(prose), prose).toEqual({ spoken: prose, withheld: false });
      expect(speak(prose, 1).spoken, `${prose} (char by char)`).toBe(prose);
    }
  });

  it("starts speaking a sentence from its first characters", () => {
    const filter = new SpokenTextFilter();
    expect(filter.push("Tw")).toBe("Tw");
    expect(filter.push("o sessions")).toBe("o sessions");
    // A line that might still be a list or a divider is held back only until it can be told apart.
    expect(filter.push("\n-")).toBe("\n");
    expect(filter.push(" item")).toBe("");
    expect(filter.push("\n*")).toBe("");
    expect(filter.push("*Done*")).toBe("**Done*");
  });

  it("resets between assistant messages", () => {
    const filter = new SpokenTextFilter();
    filter.push("On it.\n---\nhidden");
    expect(filter.withheld).toBe(true);
    filter.flush();
    filter.reset();
    expect(filter.withheld).toBe(false);
    expect(filter.push("All done.")).toBe("All done.");
  });
});
