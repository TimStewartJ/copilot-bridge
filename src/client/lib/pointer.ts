const SOFT_KEYBOARD_VIEWPORT_RATIO = 0.8;

interface KeyboardAwareNavigator extends Navigator {
  virtualKeyboard?: { readonly boundingRect: Pick<DOMRectReadOnly, "height"> };
}

function matchesMedia(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return fallback;
  }
}

export function hasFinePointer(): boolean {
  return matchesMedia("(pointer: fine)", true);
}

/**
 * Best-effort detection for an open on-screen keyboard. Browsers do not expose
 * hardware-keyboard presence, so a coarse pointer plus a substantially reduced visual
 * viewport are useful signals, not proof of hardware-keyboard presence. Reported
 * overlay-keyboard geometry takes precedence; missing viewport data stays conservative.
 */
export function usesSoftKeyboard(): boolean {
  const keyboardHeight = typeof window === "undefined"
    ? undefined
    : (window.navigator as KeyboardAwareNavigator | undefined)?.virtualKeyboard?.boundingRect?.height;
  if (keyboardHeight !== undefined && (!Number.isFinite(keyboardHeight) || keyboardHeight !== 0)) return true;
  const fallback = !hasFinePointer();
  if (
    typeof window === "undefined"
    || typeof document === "undefined"
    || !window.visualViewport
  ) {
    return fallback;
  }

  const layoutHeight = document.documentElement?.clientHeight ?? 0;
  const visualHeight = window.visualViewport.height;
  const scale = window.visualViewport.scale;
  if (
    !Number.isFinite(layoutHeight) || layoutHeight <= 0
    || !Number.isFinite(visualHeight) || visualHeight <= 0
    || !Number.isFinite(scale) || scale <= 0
  ) return fallback;

  return (visualHeight * scale) / layoutHeight < SOFT_KEYBOARD_VIEWPORT_RATIO;
}
