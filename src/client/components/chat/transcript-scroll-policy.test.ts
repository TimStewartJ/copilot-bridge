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
    { label: "moving up to exactly a screen from the top", previousScrollTop: 900, scrollTop: 600, expected: false },
    // A long reply under a collapsed run opens with the reader almost at the top of what is loaded.
    { label: "reading down from near the top", previousScrollTop: 90, scrollTop: 300, expected: false },
    { label: "an event that did not move", previousScrollTop: 250, scrollTop: 250, expected: false },
  ])("$label: $expected", ({ previousScrollTop, scrollTop, expected }) => {
    expect(shouldPrefetchOlderPage({ ...screen, previousScrollTop, scrollTop })).toBe(expected);
  });

});

describe("shouldFillFromTop", () => {
  it.each([
    { label: "a window too short to scroll", clientHeight: 600, maxScrollTop: 0, scrollTop: 0, expected: true },
    { label: "a reader below the top", clientHeight: 600, maxScrollTop: 400, scrollTop: 1, expected: false },
    { label: "a scroller not laid out yet", clientHeight: 0, maxScrollTop: 0, scrollTop: 0, expected: false },
  ])("$label: $expected", ({ expected, ...geometry }) => {
    expect(shouldFillFromTop(geometry)).toBe(expected);
  });
});

describe("isHeldOnParkedReply", () => {
  it.each([
    { label: "nothing parked", parkedTop: null, scrollTop: 400, expected: false },
    { label: "within the threshold above", parkedTop: 408, scrollTop: 400, expected: true },
    { label: "within the threshold below", parkedTop: 392, scrollTop: 400, expected: true },
    { label: "moved off the reply", parkedTop: 409, scrollTop: 400, expected: false },
  ])("$label: $expected", ({ parkedTop, scrollTop, expected }) => {
    expect(isHeldOnParkedReply(parkedTop, scrollTop, 8)).toBe(expected);
  });
});

describe("isTranscriptAtRest", () => {
  it.each([
    { label: "one moment short of rest", movedAt: 1_000, touching: false, now: 1_119, expected: false },
    { label: "a full moment after moving", movedAt: 1_000, touching: false, now: 1_120, expected: true },
    { label: "a finger resting on it", movedAt: 0, touching: true, now: 10_000, expected: false },
  ])("$label: $expected", ({ movedAt, touching, now, expected }) => {
    expect(isTranscriptAtRest({ movedAt, touching }, now)).toBe(expected);
  });
});
