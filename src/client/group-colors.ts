// Canonical client-side group color definitions.
// Server maintains its own list in task-group-store.ts for validation.

export const GROUP_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export const GROUP_COLOR_DOT: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  orange: "bg-orange-500",
  slate: "bg-slate-500",
};

export const GROUP_COLOR_BG: Record<string, string> = {
  blue: "bg-blue-500/8",
  purple: "bg-purple-500/8",
  amber: "bg-amber-500/8",
  rose: "bg-rose-500/8",
  cyan: "bg-cyan-500/8",
  orange: "bg-orange-500/8",
  slate: "bg-slate-500/8",
};

export const GROUP_COLOR_BORDER: Record<string, string> = {
  blue: "border-blue-500/30",
  purple: "border-purple-500/30",
  amber: "border-amber-500/30",
  rose: "border-rose-500/30",
  cyan: "border-cyan-500/30",
  orange: "border-orange-500/30",
  slate: "border-slate-500/30",
};
