import { describe, expect, it } from "vitest";
import { getSearchWithParam, getSearchWithoutParam } from "./useOverlayParam";

describe("useOverlayParam search helpers", () => {
  it("removes the overlay parameter without leaving an empty query marker", () => {
    expect(getSearchWithoutParam("?sheet=plan", "sheet")).toBe("");
  });

  it("preserves unrelated parameters when closing the overlay", () => {
    expect(getSearchWithoutParam("?task=one&sheet=plan&view=chat", "sheet")).toBe("?task=one&view=chat");
  });

  it("adds or updates the overlay parameter when opening the overlay", () => {
    expect(getSearchWithParam("?task=one&sheet=notes", "sheet", "plan")).toBe("?task=one&sheet=plan");
  });
});
