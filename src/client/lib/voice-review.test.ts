import { afterEach, describe, expect, it, vi } from "vitest";
import { describeVoiceReview, isHeldNoticeClosed, rememberHeldNoticeClosed, reviewForInsertedTranscript } from "./voice-review";

describe("closed held notices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(initial: string | null = null) {
    let stored = initial;
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    });
  }

  it("remembers the newest closed notices and forgets the oldest", () => {
    stubStorage();
    for (let job = 0; job <= 100; job++) rememberHeldNoticeClosed(`job-${job}`);

    expect(isHeldNoticeClosed("job-100")).toBe(true);
    expect(isHeldNoticeClosed("job-1")).toBe(true);
    expect(isHeldNoticeClosed("job-0")).toBe(false);
  });

  it("raises the notice again when what was stored cannot be read", () => {
    stubStorage("not json");
    expect(isHeldNoticeClosed("job-1")).toBe(false);
  });
});

describe("describeVoiceReview", () => {
  it.each([
    { reason: "coverage", message: "Not sent. Some speech may be missing." },
    { reason: "unchecked", message: "Not sent. Couldn't check for missing speech." },
  ] as const)("describes $reason", ({ reason, message }) => {
    expect(describeVoiceReview(reason)).toBe(message);
  });
});

describe("reviewForInsertedTranscript", () => {
  it("says nothing when the words cover the speech", () => {
    expect(reviewForInsertedTranscript({ largestGapSeconds: 1.9, gapStartSeconds: 3 })).toBeNull();
  });

  it("points at the gap when speech may be missing", () => {
    expect(reviewForInsertedTranscript({ largestGapSeconds: 2, gapStartSeconds: 3 })).toEqual({ reason: "coverage", gapStartSeconds: 3 });
  });

  it("holds a transcript it has no timing to check", () => {
    expect(reviewForInsertedTranscript(null)).toEqual({ reason: "unchecked" });
    expect(reviewForInsertedTranscript(undefined)).toEqual({ reason: "unchecked" });
  });
});
