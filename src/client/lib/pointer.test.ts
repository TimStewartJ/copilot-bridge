import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFinePointer, usesSoftKeyboard } from "./pointer";

function stubPointerAndViewport({
  pointerFine,
  layoutHeight,
  visualHeight,
  scale = 1,
}: {
  pointerFine: boolean;
  layoutHeight?: number;
  visualHeight?: number;
  scale?: number;
}): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: query === "(pointer: fine)" && pointerFine }),
    visualViewport: visualHeight === undefined ? undefined : { height: visualHeight, scale },
  });
  vi.stubGlobal("document", {
    documentElement: { clientHeight: layoutHeight ?? 0 },
  });
}

describe("pointer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a fine pointer when the media query matches", () => {
    stubPointerAndViewport({ pointerFine: true, layoutHeight: 800, visualHeight: 480 });
    expect(hasFinePointer()).toBe(true);
    expect(usesSoftKeyboard()).toBe(false);
  });

  it("reports a soft keyboard when a coarse-pointer viewport is reduced", () => {
    stubPointerAndViewport({ pointerFine: false, layoutHeight: 800, visualHeight: 480 });
    expect(hasFinePointer()).toBe(false);
    expect(usesSoftKeyboard()).toBe(true);
  });

  it("reports a hardware keyboard when a coarse-pointer viewport remains unobscured", () => {
    stubPointerAndViewport({ pointerFine: false, layoutHeight: 800, visualHeight: 800 });
    expect(hasFinePointer()).toBe(false);
    expect(usesSoftKeyboard()).toBe(false);
  });

  it("accounts for pinch zoom when comparing viewport heights", () => {
    stubPointerAndViewport({
      pointerFine: false,
      layoutHeight: 800,
      visualHeight: 400,
      scale: 2,
    });
    expect(usesSoftKeyboard()).toBe(false);
  });

  it("preserves soft-keyboard behavior when visual viewport data is unavailable", () => {
    stubPointerAndViewport({ pointerFine: false });
    expect(usesSoftKeyboard()).toBe(true);
  });

  it("falls back to desktop behavior when matchMedia is unavailable", () => {
    vi.stubGlobal("window", {});
    expect(hasFinePointer()).toBe(true);
    expect(usesSoftKeyboard()).toBe(false);
  });

  it("falls back to desktop behavior when matchMedia throws", () => {
    vi.stubGlobal("window", {
      matchMedia: () => {
        throw new Error("unsupported query");
      },
    });
    expect(hasFinePointer()).toBe(true);
    expect(usesSoftKeyboard()).toBe(false);
  });

  it("falls back to desktop behavior without a window", () => {
    vi.stubGlobal("window", undefined);
    expect(hasFinePointer()).toBe(true);
    expect(usesSoftKeyboard()).toBe(false);
  });
});
