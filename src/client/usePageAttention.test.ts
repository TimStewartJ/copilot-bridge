import { describe, expect, it } from "vitest";
import { hasPageAttention } from "./usePageAttention.js";

describe("hasPageAttention", () => {
  it("returns true when the page is visible and focused", () => {
    expect(hasPageAttention({
      visibilityState: "visible",
      hasFocus: () => true,
    })).toBe(true);
  });

  it("returns false when the page is hidden", () => {
    expect(hasPageAttention({
      visibilityState: "hidden",
      hasFocus: () => true,
    })).toBe(false);
  });

  it("returns false when the page is visible but not focused", () => {
    expect(hasPageAttention({
      visibilityState: "visible",
      hasFocus: () => false,
    })).toBe(false);
  });
});
