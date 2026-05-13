export const VISUAL_DISPLAY_MODES = ["inline", "focus"] as const;

export type VisualDisplayMode = typeof VISUAL_DISPLAY_MODES[number];

export interface VisualViewport {
  width?: number;
  height?: number;
}

export const HTML_SANDBOX_PERMISSIONS = "allow-scripts";
