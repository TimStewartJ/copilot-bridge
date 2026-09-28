import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAPTIC_MIN_GAP_MS, haptic, resetHapticsForTest, type HapticKind } from "./haptics";

function stubHost(visibility: DocumentVisibilityState = "visible") {
  const posted: HapticKind[] = [];
  vi.stubGlobal("window", {
    webkit: { messageHandlers: { bridgeHaptic: { postMessage: (kind: HapticKind) => posted.push(kind) } } },
  });
  vi.stubGlobal("document", { visibilityState: visibility });
  return posted;
}

describe("haptic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHapticsForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts the kind to the host app once the current task finishes", () => {
    const posted = stubHost();
    haptic("light");
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(posted).toEqual(["light"]);
  });

  it("does nothing without a host app, as in a browser", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(() => {
      haptic("success");
      vi.advanceTimersByTime(0);
    }).not.toThrow();
  });

  it("stays quiet while the page is hidden", () => {
    const posted = stubHost("hidden");
    haptic("error");
    vi.advanceTimersByTime(0);
    expect(posted).toEqual([]);
  });

  it("merges requests from one task into the strongest", () => {
    const posted = stubHost();
    haptic("light");
    haptic("success");
    haptic("selection");
    vi.advanceTimersByTime(0);
    expect(posted).toEqual(["success"]);
  });

  it("drops feedback too close to the last one unless it is stronger", () => {
    const posted = stubHost();
    haptic("medium");
    vi.advanceTimersByTime(0);
    haptic("light");
    vi.advanceTimersByTime(0);
    haptic("error");
    vi.advanceTimersByTime(0);
    expect(posted).toEqual(["medium", "error"]);
    vi.advanceTimersByTime(HAPTIC_MIN_GAP_MS);
    haptic("selection");
    vi.advanceTimersByTime(0);
    expect(posted).toEqual(["medium", "error", "selection"]);
  });

  it("never lets a failing host break the caller", () => {
    vi.stubGlobal("window", {
      webkit: { messageHandlers: { bridgeHaptic: { postMessage: () => { throw new Error("gone"); } } } },
    });
    vi.stubGlobal("document", { visibilityState: "visible" });
    haptic("light");
    expect(() => vi.advanceTimersByTime(0)).not.toThrow();
  });
});
