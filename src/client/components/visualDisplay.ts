import { BarChart3, Image as ImageIcon, PanelsTopLeft, Workflow, type LucideIcon } from "lucide-react";

export const VISUAL_DISPLAY_MODES = ["inline", "focus"] as const;

export type VisualDisplayMode = typeof VISUAL_DISPLAY_MODES[number];

export interface VisualViewport {
  width?: number;
  height?: number;
}

export const HTML_SANDBOX_PERMISSIONS = "allow-scripts";

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
