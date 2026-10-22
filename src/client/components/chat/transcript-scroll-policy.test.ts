import { describe, expect, it } from "vitest";
import {
  isHeldOnParkedReply,
  isTranscriptAtRest,
  shouldFillFromTop,
  shouldPrefetchOlderPage,
} from "./transcript-scroll-policy";

describe("shouldPrefetchOlderPage", () => {
  const screen = { clientHeight: 600, loadFailed: false };

  it.each([
    { label: "moving up within a screen of the top", previousScrollTop: 900, scrollTop: 500, expected: true },
    { label: "moving up further down than a screen", previousScrollTop: 1200, scrollTop: 900, expected: false },
    { label: "moving up to exactly a screen from the top", previousScrollTop: 900, scrollTop: 600, expected: false },
    // A long reply under a collapsed run opens with the reader almost at the top of what is loaded.
    { label: "reading down from near the top", previousScrollTop: 90, scrollTop: 300, expected: false },
    { label: "a first event near the top", previousScrollTop: 0, scrollTop: 90, expected: false },
    { label: "an event that did not move", previousScrollTop: 250, scrollTop: 250, expected: false },
    { label: "turning back up near the top", previousScrollTop: 300, scrollTop: 250, expected: true },
  ])("$label: $expected", ({ previousScrollTop, scrollTop, expected }) => {
    expect(shouldPrefetchOlderPage({ ...screen, previousScrollTop, scrollTop })).toBe(expected);
  });

  it("waits for Retry once a page has failed", () => {
    expect(shouldPrefetchOlderPage({ ...screen, loadFailed: true, previousScrollTop: 900, scrollTop: 500 })).toBe(false);
  });
});

describe("shouldFillFromTop", () => {
  it.each([
    { label: "a window too short to scroll", clientHeight: 600, maxScrollTop: 0, scrollTop: 0, expected: true },
    { label: "a reader parked at the very top", clientHeight: 600, maxScrollTop: 400, scrollTop: 0, expected: true },
    { label: "a reader below the top", clientHeight: 600, maxScrollTop: 400, scrollTop: 1, expected: false },
    { label: "a scroller not laid out yet", clientHeight: 0, maxScrollTop: 0, scrollTop: 0, expected: false },
    { label: "a scroller with no measurable height", clientHeight: NaN, maxScrollTop: 0, scrollTop: 0, expected: false },
  ])("$label: $expected", ({ expected, ...geometry }) => {
    expect(shouldFillFromTop(geometry)).toBe(expected);
  });
});

describe("isHeldOnParkedReply", () => {
  it.each([
    { label: "nothing parked", parkedTop: null, scrollTop: 400, expected: false },
    { label: "the view still starts at the reply", parkedTop: 400, scrollTop: 400, expected: true },
    { label: "within the threshold above", parkedTop: 408, scrollTop: 400, expected: true },
    { label: "within the threshold below", parkedTop: 392, scrollTop: 400, expected: true },
    { label: "moved off the reply", parkedTop: 409, scrollTop: 400, expected: false },
  ])("$label: $expected", ({ parkedTop, scrollTop, expected }) => {
    expect(isHeldOnParkedReply(parkedTop, scrollTop, 8)).toBe(expected);
  });
});

describe("isTranscriptAtRest", () => {
  it.each([
    { label: "never moved", movedAt: 0, touching: false, now: 1_000, expected: true },
    { label: "moved just now", movedAt: 1_000, touching: false, now: 1_100, expected: false },
    { label: "one moment short of rest", movedAt: 1_000, touching: false, now: 1_119, expected: false },
    { label: "a full moment after moving", movedAt: 1_000, touching: false, now: 1_120, expected: true },
    { label: "a finger resting on it", movedAt: 0, touching: true, now: 10_000, expected: false },
  ])("$label: $expected", ({ movedAt, touching, now, expected }) => {
    expect(isTranscriptAtRest({ movedAt, touching }, now)).toBe(expected);
  });
});
