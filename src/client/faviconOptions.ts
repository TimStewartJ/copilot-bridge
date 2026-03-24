// Favicon option registry — shared between settings UI and runtime swap

export interface FaviconOption {
  key: string;
  label: string;
  path: string;
  group: "bridge" | "alt";
}

export const FAVICON_OPTIONS: FaviconOption[] = [
  // Bridge variants (5 colours)
  { key: "indigo-bridge", label: "Indigo", path: "/favicons/indigo-bridge.svg", group: "bridge" },
  { key: "emerald-bridge", label: "Emerald", path: "/favicons/emerald-bridge.svg", group: "bridge" },
  { key: "amber-bridge", label: "Amber", path: "/favicons/amber-bridge.svg", group: "bridge" },
  { key: "rose-bridge", label: "Rose", path: "/favicons/rose-bridge.svg", group: "bridge" },
  { key: "cyan-bridge", label: "Cyan", path: "/favicons/cyan-bridge.svg", group: "bridge" },
  // Alternative icons
  { key: "copilot-sparkle", label: "Sparkle", path: "/favicons/copilot-sparkle.svg", group: "alt" },
  { key: "terminal", label: "Terminal", path: "/favicons/terminal.svg", group: "alt" },
  { key: "minimal-dot", label: "Minimal", path: "/favicons/minimal-dot.svg", group: "alt" },
];

export const DEFAULT_FAVICON = "indigo-bridge";

export function getFaviconPath(key?: string): string {
  const opt = FAVICON_OPTIONS.find((o) => o.key === key);
  return opt?.path ?? FAVICON_OPTIONS[0].path;
}
