/** Haptics via the host app's bridgeHaptic handler (no-op elsewhere); for events, not every tap. */
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

/** Haptic feedback from the host app; requests within one task merge into the strongest. */
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
