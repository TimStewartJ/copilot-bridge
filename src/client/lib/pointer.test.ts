import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFinePointer, usesSoftKeyboard } from "./pointer";

function stubWindowMatchMedia(impl: (query: string) => boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: impl(query) }),
  });
}

describe("pointer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a fine pointer when the media query matches", () => {
    stubWindowMatchMedia((query) => query === "(pointer: fine)");
    expect(hasFinePointer()).toBe(true);
    expect(usesSoftKeyboard()).toBe(false);
  });

  it("reports a soft keyboard when the pointer is coarse", () => {
    stubWindowMatchMedia(() => false);
    expect(hasFinePointer()).toBe(false);
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
