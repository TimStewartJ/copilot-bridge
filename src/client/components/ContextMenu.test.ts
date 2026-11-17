import { describe, expect, it } from "vitest";
import { placeContextMenu } from "./ContextMenu";

const size = { width: 200, height: 300 };
const viewport = { width: 390, height: 844 };

describe("placeContextMenu", () => {
  it.each([
    { name: "below opens at the point", placement: "below", anchorGap: 0, y: 100, top: 100 },
    { name: "below flips up near the bottom", placement: "below", anchorGap: 0, y: 700, top: 400 },
    { name: "above without a gap clamps at the top", placement: "above", anchorGap: 0, y: 120, top: 8 },
    { name: "above keeps the gap clear", placement: "above", anchorGap: 24, y: 600, top: 276 },
    { name: "above flips below the gap near the top", placement: "above", anchorGap: 24, y: 150, top: 174 },
  ] as const)("$name", ({ placement, anchorGap, y, top }) => {
    expect(placeContextMenu({ position: { x: 10, y }, size, viewport, placement, anchorGap }).top).toBe(top);
  });

  it("keeps a too-tall menu inside a short viewport and shifts left off the right edge", () => {
    const placed = placeContextMenu({
      position: { x: 300, y: 200 },
      size: { width: 200, height: 500 },
      viewport: { width: 390, height: 400 },
      placement: "below",
      anchorGap: 0,
    });
    expect(placed).toEqual({ top: 8, left: 182 });
  });
});
