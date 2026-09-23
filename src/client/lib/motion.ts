// Reduced-motion resolution. The Appearance setting can override the device preference, so
// CSS and scripts read the resolved `data-motion` attribute on <html> instead of the media query.

import type { MotionPreference } from "../api";

export type EffectiveMotion = "reduce" | "full";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function deviceReducesMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function resolveMotion(preference: MotionPreference): EffectiveMotion {
  if (preference === "system") return deviceReducesMotion() ? "reduce" : "full";
  return preference;
}

export function applyMotion(effective: EffectiveMotion): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-motion", effective);
}

/** True when motion should be reduced, honouring the saved override before the device setting. */
export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined") {
    const applied = document.documentElement.getAttribute("data-motion");
    if (applied === "reduce") return true;
    if (applied === "full") return false;
  }
  return deviceReducesMotion();
}
