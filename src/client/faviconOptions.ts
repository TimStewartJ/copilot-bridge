// Favicon option registry — shared between settings UI and runtime swap

export interface FaviconOption {
  key: string;
  label: string;
  path: string;
  lightPath: string;
  group: "bridge" | "alt";
}

export const FAVICON_OPTIONS: FaviconOption[] = [
  // Bridge variants (5 colours)
  { key: "indigo-bridge", label: "Indigo", path: "/favicons/v2/indigo-bridge.svg", lightPath: "/favicons/v2/indigo-bridge-light.svg", group: "bridge" },
  { key: "emerald-bridge", label: "Emerald", path: "/favicons/v2/emerald-bridge.svg", lightPath: "/favicons/v2/emerald-bridge-light.svg", group: "bridge" },
  { key: "amber-bridge", label: "Amber", path: "/favicons/v2/amber-bridge.svg", lightPath: "/favicons/v2/amber-bridge-light.svg", group: "bridge" },
  { key: "rose-bridge", label: "Rose", path: "/favicons/v2/rose-bridge.svg", lightPath: "/favicons/v2/rose-bridge-light.svg", group: "bridge" },
  { key: "cyan-bridge", label: "Cyan", path: "/favicons/v2/cyan-bridge.svg", lightPath: "/favicons/v2/cyan-bridge-light.svg", group: "bridge" },
  // Alternative icons
  { key: "copilot-sparkle", label: "Sparkle", path: "/favicons/v2/copilot-sparkle.svg", lightPath: "/favicons/v2/copilot-sparkle-light.svg", group: "alt" },
  { key: "terminal", label: "Terminal", path: "/favicons/v2/terminal.svg", lightPath: "/favicons/v2/terminal-light.svg", group: "alt" },
  { key: "minimal-dot", label: "Minimal", path: "/favicons/v2/minimal-dot.svg", lightPath: "/favicons/v2/minimal-dot-light.svg", group: "alt" },
];

export const DEFAULT_FAVICON = "indigo-bridge";

// Derive asset base from Vite's BASE_URL — enables staging previews at /staging/<prefix>/
const ASSET_BASE = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

/** Resolve a registry path against the deployment base path. */
export function faviconAssetUrl(path: string): string {
  return `${ASSET_BASE}${path}`;
}

export function getFaviconPath(key?: string, effectiveTheme: "light" | "dark" = "dark"): string {
  const opt = FAVICON_OPTIONS.find((o) => o.key === key);
  const fallback = FAVICON_OPTIONS[0];
  const target = opt ?? fallback;
  return faviconAssetUrl(effectiveTheme === "light" ? target.lightPath : target.path);
}
