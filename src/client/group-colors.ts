// Canonical client-side group color definitions.
// Server maintains its own list in task-group-store.ts for validation.
// The classes come from the design system's identity colours (design/identity.ts).

import { IDENTITY_EDGE, IDENTITY_FILL, IDENTITY_TINT } from "./design/identity";

export const GROUP_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export const GROUP_COLOR_DOT: Record<string, string> = IDENTITY_FILL;

export const GROUP_COLOR_BG: Record<string, string> = IDENTITY_TINT;

export const GROUP_COLOR_BORDER: Record<string, string> = IDENTITY_EDGE;
