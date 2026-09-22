// Tag color definitions for rendering tag pills.
// The classes come from the design system's identity colours (design/identity.ts).

import { IDENTITY_EDGE, IDENTITY_FILL, IDENTITY_TEXT, IDENTITY_TINT } from "./design/identity";

export const TAG_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate", "emerald", "indigo", "pink",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export const TAG_COLOR_BG: Record<string, string> = IDENTITY_TINT;

export const TAG_COLOR_TEXT: Record<string, string> = IDENTITY_TEXT;

export const TAG_COLOR_BORDER: Record<string, string> = IDENTITY_EDGE;

export const TAG_COLOR_DOT: Record<string, string> = IDENTITY_FILL;
