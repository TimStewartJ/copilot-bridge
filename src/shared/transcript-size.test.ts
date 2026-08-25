import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SIZE_WARNING_BYTES, getTranscriptSizeWarning } from "./transcript-size.js";

describe("transcript size warning", () => {
  it("stays quiet for missing, invalid, and below-threshold sizes", () => {
    expect(getTranscriptSizeWarning()).toBeNull();
    expect(getTranscriptSizeWarning(Number.NaN)).toBeNull();
    expect(getTranscriptSizeWarning(TRANSCRIPT_SIZE_WARNING_BYTES - 1)).toBeNull();
  });

  it("formats a warning once the transcript reaches the threshold", () => {
    expect(getTranscriptSizeWarning(96.125 * 1024 * 1024)).toBe(
      "Large transcript (96.1 MB). Long sessions slow down history reads and make recurring defers expensive; consider starting a fresh session for new work.",
    );
  });
});
