/**
 * Primary-pointer helpers. A fine pointer (mouse/trackpad) means a desktop-style
 * device with a hardware keyboard; a coarse pointer means touch input where text is
 * typed on an on-screen keyboard.
 */

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
 * True when typing happens on an on-screen keyboard. Its return key should insert a
 * newline rather than submit, because there is no Shift+Enter affordance on touch.
 */
export function usesSoftKeyboard(): boolean {
  return !hasFinePointer();
}
