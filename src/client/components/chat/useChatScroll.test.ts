import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, type Act } from "../../test-react-harness";
import { getDistanceFromBottom, getMaxScrollTop, getSafeScrollTop, useChatScroll } from "./useChatScroll";

afterEach(() => vi.restoreAllMocks());

async function withScroll(run: (helpers: {
  get: () => ReturnType<typeof useChatScroll>;
  frames: Map<number, FrameRequestCallback>;
  act: Act;
}) => Promise<void>) {
  const harness = await createReactDomHarness();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  let value!: ReturnType<typeof useChatScroll>;
  function Probe() {
    value = useChatScroll(true);
    return createElement("div", { ref: value.scrollContainerRef });
  }
  try {
    await harness.render(createElement(Probe));
    const scroller = value.scrollContainerRef.current;
    if (!scroller) throw new Error("Scroll test did not mount its scroller");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });
    await run({ get: () => value, frames, act: harness.act });
  } finally {
    await harness.cleanup();
    expect(frames.size).toBe(0);
  }
}

describe("chat scrolling", () => {
  it("stops following on reader intent and resumes only when explicitly requested", async () => {
    await withScroll(async ({ get, act }) => {
      const scroller = get().scrollContainerRef.current;
      if (!scroller) throw new Error("Missing scroller");
      scroller.scrollTop = 100;
      await act(async () => get().handleUserScrollIntent());
      expect(get().stickToBottomRef.current).toBe(false);
      expect(get().showJumpToLatest).toBe(true);
      await act(async () => get().scrollToLatest({ immediate: true }));
      expect(scroller.scrollTop).toBe(100);
      await act(async () => get().scrollToLatest({ immediate: true, force: true }));
      expect(scroller.scrollTop).toBe(800);
      expect(get().stickToBottomRef.current).toBe(true);
      expect(get().showJumpToLatest).toBe(false);
    });
  });

  it("cancels a scheduled animation when the reader takes control", async () => {
    await withScroll(async ({ get, frames, act }) => {
      await act(async () => get().scrollToLatest());
      expect(frames.size).toBe(1);
      await act(async () => get().handleUserScrollIntent());
      expect(frames.size).toBe(0);
      expect(get().programmaticScrollRef.current).toBe(false);
    });
  });

  it("keeps scroll arithmetic finite for incomplete layout measurements", async () => {
    await withScroll(async ({ get }) => {
      const scroller = get().scrollContainerRef.current;
      if (!scroller) throw new Error("Missing scroller");
      scroller.scrollTop = Number.NaN;
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: Number.NaN });
      expect(getSafeScrollTop(scroller)).toBe(0);
      expect(getMaxScrollTop(scroller)).toBe(0);
      expect(getDistanceFromBottom(scroller)).toBe(0);
    });
  });
});
