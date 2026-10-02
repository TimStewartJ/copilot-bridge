import { describe, expect, it } from "vitest";
import { takeSpeechChunks } from "../src/index.js";

describe("takeSpeechChunks", () => {
  it("emits complete sentences and keeps the remainder", () => {
    const result = takeSpeechChunks("Two sessions finished. The backup run is still", { firstChunk: false });
    expect(result.chunks).toEqual(["Two sessions finished."]);
    expect(result.rest).toBe(" The backup run is still");
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

  it("keeps the first spoken clause short so audio starts sooner", () => {
    const result = takeSpeechChunks("I checked the backup task for you, and both sessions are still running. ", { firstChunk: true });
    expect(result.chunks[0]).toBe("I checked the backup task for you,");
  });

  it("leaves later sentences whole", () => {
    const text = "Octopuses have three hearts, and two of them stop beating whenever they swim through open water. ";
    expect(takeSpeechChunks(text, { firstChunk: false }).chunks).toEqual([text.trim()]);
  });

  it("flushes the tail", () => {
    expect(takeSpeechChunks("Sure", { firstChunk: true, flush: true })).toEqual({ chunks: ["Sure"], rest: "" });
  });

  it("does not split short abbreviations into tiny chunks", () => {
    const result = takeSpeechChunks("Ok. Sounds good to me. ", { firstChunk: false });
    expect(result.chunks).toEqual(["Ok. Sounds good to me."]);
  });

  it("cuts a very long sentence at clause boundaries", () => {
    const clause = "the report covers the last quarter in detail";
    const sentence = `${Array.from({ length: 8 }, () => clause).join(", ")}. `;
    const { chunks } = takeSpeechChunks(sentence, { firstChunk: false });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 240)).toBe(true);
    expect(chunks.join(" ")).toBe(sentence.trim());
  });

  it("carries text across calls the way a streaming caller does", () => {
    const deltas = ["The build ", "passed. Two te", "sts were skipped, ", "which is expected. "];
    const spoken: string[] = [];
    let pending = "";
    for (const delta of deltas) {
      const { chunks, rest } = takeSpeechChunks(pending + delta, { firstChunk: spoken.length === 0 });
      spoken.push(...chunks);
      pending = rest;
    }
    expect(spoken).toEqual(["The build passed.", "Two tests were skipped, which is expected."]);
    expect(pending.trim()).toBe("");
  });
});
