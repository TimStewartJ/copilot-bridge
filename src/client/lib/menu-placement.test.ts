import { describe, expect, it } from "vitest";
import {
  MAX_MENU_HEIGHT,
  VIEWPORT_PADDING,
  computeMenuPlacement,
  type AnchorRect,
} from "./menu-placement";

const VIEWPORT = { width: 1200, height: 800 };
const MENU = { width: 208, height: 240 };

function anchor(overrides: Partial<AnchorRect> = {}): AnchorRect {
  return { top: 100, bottom: 130, left: 40, width: 150, ...overrides };
}

describe("computeMenuPlacement", () => {
  it("opens below the anchor when there is room", () => {
    const placement = computeMenuPlacement(anchor(), MENU, VIEWPORT);
    expect(placement?.top).toBe(134);
    expect(placement?.left).toBe(40);
  });

  it("matches the anchor width as a minimum so the menu never looks detached", () => {
    const placement = computeMenuPlacement(anchor({ width: 180 }), MENU, VIEWPORT);
    expect(placement?.minWidth).toBe(180);
  });

  it("flips above the anchor when the anchor sits near the bottom", () => {
    const placement = computeMenuPlacement(
      anchor({ top: 740, bottom: 770 }),
      MENU,
      VIEWPORT,
    );
    // 740 - 4 gap - 240 menu height
    expect(placement?.top).toBe(496);
  });

  it("keeps the menu fully on screen when space is tight on both sides", () => {
    const viewport = { width: 1200, height: 260 };
    const placement = computeMenuPlacement(
      anchor({ top: 150, bottom: 180 }),
      MENU,
      viewport,
    );
    expect(placement!.top).toBeGreaterThanOrEqual(VIEWPORT_PADDING);
    // The rendered box must not run past the bottom edge, which is the bug
    // that made the menu look cut off.
    expect(placement!.top + placement!.maxHeight)
      .toBeLessThanOrEqual(viewport.height - VIEWPORT_PADDING);
  });

  it("caps the height to the available space instead of overflowing", () => {
    const placement = computeMenuPlacement(
      anchor({ top: 400, bottom: 430 }),
      MENU,
      { width: 1200, height: 600 },
    );
    // 600 - 430 - 4 - 8 = 158 of usable space below.
    expect(placement?.maxHeight).toBe(158);
    expect(placement!.maxHeight).toBeLessThan(MAX_MENU_HEIGHT);
  });

  it("never caps the height below the readable minimum", () => {
    const placement = computeMenuPlacement(
      anchor({ top: 260, bottom: 290 }),
      MENU,
      { width: 1200, height: 300 },
    );
    expect(placement!.maxHeight).toBeGreaterThanOrEqual(96);
  });

  it("clamps a right-edge anchor back inside the viewport", () => {
    const placement = computeMenuPlacement(
      anchor({ left: 1150 }),
      MENU,
      VIEWPORT,
    );
    expect(placement?.left).toBe(VIEWPORT.width - MENU.width - VIEWPORT_PADDING);
  });

  it("clamps a negative anchor position to the viewport padding", () => {
    const placement = computeMenuPlacement(anchor({ left: -60 }), MENU, VIEWPORT);
    expect(placement?.left).toBe(VIEWPORT_PADDING);
  });

  it("falls back to the anchor width when the menu has not been measured", () => {
    const placement = computeMenuPlacement(
      anchor({ left: 1150, width: 150 }),
      { width: 0, height: 0 },
      VIEWPORT,
    );
    expect(placement?.left).toBe(VIEWPORT.width - 150 - VIEWPORT_PADDING);
    expect(placement?.maxHeight).toBe(MAX_MENU_HEIGHT);
  });

  it("returns null for an unknown viewport so callers can fall back", () => {
    expect(computeMenuPlacement(anchor(), MENU, { width: 0, height: 0 })).toBeNull();
  });
});
