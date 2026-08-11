const SOFT_KEYBOARD_VIEWPORT_RATIO = 0.8;

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
 * viewport is the closest practical signal. Preserve newline behavior when the Visual
 * Viewport API is unavailable.
 */
export function usesSoftKeyboard(): boolean {
  if (hasFinePointer()) return false;
  if (
    typeof window === "undefined"
    || typeof document === "undefined"
    || !window.visualViewport
  ) {
    return true;
  }

  const layoutHeight = document.documentElement?.clientHeight ?? 0;
  const visualHeight = window.visualViewport.height;
  if (layoutHeight <= 0 || visualHeight <= 0) return true;

  const scale = window.visualViewport.scale > 0 ? window.visualViewport.scale : 1;
  return (visualHeight * scale) / layoutHeight < SOFT_KEYBOARD_VIEWPORT_RATIO;
}
