import { describe, expect, it } from "vitest";
import { SpokenTextFilter } from "../src/index.js";

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
    // The shape of a reply a fast model gave to "what are my most recent tasks".
    const reply = "The three most recently updated active tasks are shown on screen:\n\n"
      + "- [Quarterly report](https://example.com/task/1)\n"
      + "- [Website redesign](https://example.com/task/2)\n"
      + "- [Onboarding checklist](https://example.com/task/3)\n\n";
    expect(speak(reply)).toEqual({ spoken: "The three most recently updated active tasks are shown on screen:", withheld: true });
  });

  it("picks the conversation back up after the structure ends", () => {
    expect(speak("Two need you.\n\n1. Deploy check\n2) Backup job\n   still waiting on a question\n\nWant me to read the first one?").spoken)
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
      "[The build](https://example.com/builds/7) is waiting on you.",
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
