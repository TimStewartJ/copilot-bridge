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
  { key: "indigo-bridge", label: "Indigo", path: "/favicons/indigo-bridge.svg", lightPath: "/favicons/indigo-bridge-light.svg", group: "bridge" },
  { key: "emerald-bridge", label: "Emerald", path: "/favicons/emerald-bridge.svg", lightPath: "/favicons/emerald-bridge-light.svg", group: "bridge" },
  { key: "amber-bridge", label: "Amber", path: "/favicons/amber-bridge.svg", lightPath: "/favicons/amber-bridge-light.svg", group: "bridge" },
  { key: "rose-bridge", label: "Rose", path: "/favicons/rose-bridge.svg", lightPath: "/favicons/rose-bridge-light.svg", group: "bridge" },
  { key: "cyan-bridge", label: "Cyan", path: "/favicons/cyan-bridge.svg", lightPath: "/favicons/cyan-bridge-light.svg", group: "bridge" },
  // Alternative icons
  { key: "copilot-sparkle", label: "Sparkle", path: "/favicons/copilot-sparkle.svg", lightPath: "/favicons/copilot-sparkle-light.svg", group: "alt" },
  { key: "terminal", label: "Terminal", path: "/favicons/terminal.svg", lightPath: "/favicons/terminal-light.svg", group: "alt" },
  { key: "minimal-dot", label: "Minimal", path: "/favicons/minimal-dot.svg", lightPath: "/favicons/minimal-dot-light.svg", group: "alt" },
];

export const DEFAULT_FAVICON = "indigo-bridge";

export function getFaviconPath(key?: string, effectiveTheme: "light" | "dark" = "dark"): string {
  const opt = FAVICON_OPTIONS.find((o) => o.key === key);
  const fallback = FAVICON_OPTIONS[0];
  const target = opt ?? fallback;
  return effectiveTheme === "light" ? target.lightPath : target.path;
}
