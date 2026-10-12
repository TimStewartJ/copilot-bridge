import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFinePointer, usesSoftKeyboard } from "./pointer";

function stubPointerAndViewport({
  pointerFine,
  layoutHeight,
  visualHeight,
  scale = 1,
  keyboardHeight,
}: {
  pointerFine: boolean;
  layoutHeight?: number;
  visualHeight?: number;
  scale?: number;
  keyboardHeight?: number;
}): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: query === "(pointer: fine)" && pointerFine }),
    visualViewport: visualHeight === undefined ? undefined : { height: visualHeight, scale },
    navigator: {
      virtualKeyboard: keyboardHeight === undefined ? undefined : { boundingRect: { height: keyboardHeight } },
    },
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
    stubPointerAndViewport({ pointerFine: true, layoutHeight: 800, visualHeight: 800 });
    expect(hasFinePointer()).toBe(true);
    expect(usesSoftKeyboard()).toBe(false);
  });

  it("reports a soft keyboard when a coarse-pointer viewport is reduced", () => {
    stubPointerAndViewport({ pointerFine: false, layoutHeight: 800, visualHeight: 480 });
    expect(hasFinePointer()).toBe(false);
    expect(usesSoftKeyboard()).toBe(true);
  });

  it("recognizes viewport occlusion on a touch device with a mouse or trackpad", () => {
    stubPointerAndViewport({ pointerFine: true, layoutHeight: 800, visualHeight: 480 });
    expect(hasFinePointer()).toBe(true);
    expect(usesSoftKeyboard()).toBe(true);
  });

  it("reports no viewport evidence of a soft keyboard when a coarse-pointer viewport remains unobscured", () => {
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

  it.each([false, true])("recognizes a reported overlay keyboard with fine pointer %s", (pointerFine) => {
    stubPointerAndViewport({ pointerFine, layoutHeight: 800, visualHeight: 800, keyboardHeight: 300 });
    expect(usesSoftKeyboard()).toBe(true);
  });

  it("does not treat zero virtual keyboard geometry as proof of a hardware keyboard", () => {
    stubPointerAndViewport({ pointerFine: false, keyboardHeight: 0 });
    expect(usesSoftKeyboard()).toBe(true);
  });

  it.each([
    { layoutHeight: NaN, visualHeight: 800, scale: 1 },
    { layoutHeight: Infinity, visualHeight: 800, scale: 1 },
    { layoutHeight: 800, visualHeight: NaN, scale: 1 },
    { layoutHeight: 800, visualHeight: Infinity, scale: 1 },
    { layoutHeight: 800, visualHeight: 800, scale: NaN },
    { layoutHeight: 800, visualHeight: 800, scale: Infinity },
    { layoutHeight: 800, visualHeight: 800, scale: 0 },
    { layoutHeight: 800, visualHeight: 800, scale: -1 },
  ])("stays conservative with invalid viewport data %j", (geometry) => {
    stubPointerAndViewport({ pointerFine: false, ...geometry });
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
