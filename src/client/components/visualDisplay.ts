import { HTML_SANDBOX } from "../../shared/html-sandbox.js";
import { BarChart3, Image as ImageIcon, PanelsTopLeft, Workflow, type LucideIcon } from "lucide-react";

export const VISUAL_DISPLAY_MODES = ["inline", "focus"] as const;

export type VisualDisplayMode = typeof VISUAL_DISPLAY_MODES[number];

export interface VisualViewport {
  width?: number;
  height?: number;
}

export const HTML_SANDBOX_PERMISSIONS = HTML_SANDBOX;

const VISUAL_KINDS: Record<string, { label: string; Icon: LucideIcon }> = {
  image: { label: "Image", Icon: ImageIcon },
  mermaid: { label: "Diagram", Icon: Workflow },
  "vega-lite": { label: "Chart", Icon: BarChart3 },
  html: { label: "Interactive", Icon: PanelsTopLeft },
};

/** What a published visual is, in a word and an icon. */
export function describeVisualKind(kind: string): { label: string; Icon: LucideIcon } {
  return VISUAL_KINDS[kind] ?? { label: "Visual", Icon: ImageIcon };
}

/**
 * Puts the app's base path in front of a visual's URLs that start at the API root. Published
 * visuals already carry it; generated images come from history as `/api/...`, which a staging
 * preview serves under its own prefix.
 */
export function withAppBase<T extends { url: string; downloadUrl: string }>(visual: T, base: string): T {
  const resolve = (url: string) => (base && url.startsWith("/api/") ? `${base}${url}` : url);
  const url = resolve(visual.url);
  const downloadUrl = resolve(visual.downloadUrl);
  return url === visual.url && downloadUrl === visual.downloadUrl ? visual : { ...visual, url, downloadUrl };
}
