/**
 * Haptic feedback for pages shown inside a native app that offers it, such as Tether on iPhone. Web
 * pages cannot vibrate an iPhone themselves, so the host app posts the feedback for us through a
 * one-way WebKit message handler named `bridgeHaptic`. Anywhere else (a browser, desktop) every call
 * is a no-op.
 *
 * Use it for things that happen, not for every tap: a value snapping into place (`selection`), a
 * gesture reaching its trigger or a message leaving (`light`, `medium`), and outcomes (`success`,
 * `warning`, `error`). Navigation, scrolling, typing and background updates get none.
 */
export type HapticKind = "selection" | "light" | "medium" | "success" | "warning" | "error";

export const HAPTIC_KINDS: readonly HapticKind[] = ["selection", "light", "medium", "success", "warning", "error"];

const STRENGTH: Record<HapticKind, number> = {
  selection: 0,
  light: 1,
  medium: 2,
  success: 3,
  warning: 3,
  error: 3,
};

/** Feedback closer together than this blurs into one buzz, so only a stronger one gets through. */
export const HAPTIC_MIN_GAP_MS = 80;

interface HapticHost {
  postMessage: (kind: HapticKind) => void;
}

type HapticWindow = Window & {
  webkit?: { messageHandlers?: Record<string, HapticHost | undefined> };
};

function findHost(): HapticHost | null {
  if (typeof window === "undefined") return null;
  const handler = (window as HapticWindow).webkit?.messageHandlers?.bridgeHaptic;
  return handler && typeof handler.postMessage === "function" ? handler : null;
}

let pending: HapticKind | null = null;
let flushScheduled = false;
let lastPlayed: { kind: HapticKind; at: number } | null = null;

function flush() {
  flushScheduled = false;
  const kind = pending;
  pending = null;
  if (!kind) return;
  const now = Date.now();
  if (lastPlayed && now - lastPlayed.at < HAPTIC_MIN_GAP_MS && STRENGTH[kind] <= STRENGTH[lastPlayed.kind]) return;
  const host = findHost();
  if (!host) return;
  lastPlayed = { kind, at: now };
  try {
    host.postMessage(kind);
  } catch {
    // Feedback is decoration; a host that went away must never break the action that asked for it.
  }
}

/**
 * Asks the host app for haptic feedback. Requests made while one task runs (a click handler and the
 * promise callbacks it settles, say a copy and its "Copied" toast) merge into the strongest of them.
 */
export function haptic(kind: HapticKind): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (!findHost()) return;
  if (!pending || STRENGTH[kind] > STRENGTH[pending]) pending = kind;
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(flush, 0);
}

/** Test hook: forgets queued and recent feedback. */
export function resetHapticsForTest(): void {
  pending = null;
  flushScheduled = false;
  lastPlayed = null;
}
