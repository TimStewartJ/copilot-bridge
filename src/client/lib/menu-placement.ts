export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
}

export const VIEWPORT_PADDING = 8;
export const ANCHOR_GAP = 4;
export const MAX_MENU_HEIGHT = 256;
export const MIN_MENU_HEIGHT = 96;

/**
 * Places a popover against the viewport instead of its nearest positioned
 * ancestor. Anchored menus inside a scrolling row cannot use absolute
 * positioning, because a scroll container clips absolutely positioned children
 * on both axes and cuts the menu off.
 *
 * Returns null when the viewport is unknown (for example the test DOM), letting
 * the caller fall back to static positioning.
 */
export function computeMenuPlacement(
  anchor: AnchorRect,
  menu: MenuSize,
  viewport: Viewport,
): MenuPlacement | null {
  if (!viewport.width || !viewport.height) return null;

  const spaceBelow = viewport.height - anchor.bottom - ANCHOR_GAP - VIEWPORT_PADDING;
  const spaceAbove = anchor.top - ANCHOR_GAP - VIEWPORT_PADDING;
  // Flip up only when below is genuinely cramped and above has more room.
  const placeAbove = spaceBelow < MIN_MENU_HEIGHT && spaceAbove > spaceBelow;
  const available = Math.max(placeAbove ? spaceAbove : spaceBelow, MIN_MENU_HEIGHT);
  const maxHeight = Math.min(MAX_MENU_HEIGHT, available);
  const height = Math.min(menu.height || maxHeight, maxHeight);

  const top = placeAbove
    ? Math.max(VIEWPORT_PADDING, anchor.top - ANCHOR_GAP - height)
    : Math.min(
      anchor.bottom + ANCHOR_GAP,
      Math.max(VIEWPORT_PADDING, viewport.height - VIEWPORT_PADDING - height),
    );

  const width = menu.width || anchor.width;
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(anchor.left, viewport.width - width - VIEWPORT_PADDING),
  );

  return { top, left, minWidth: anchor.width, maxHeight };
}
