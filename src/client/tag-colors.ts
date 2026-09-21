// Tag color definitions for rendering tag pills.

export const TAG_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate", "emerald", "indigo", "pink",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export const TAG_COLOR_BG: Record<string, string> = {
  blue: "bg-blue-500/15",
  purple: "bg-purple-500/15",
  amber: "bg-amber-500/15",
  rose: "bg-rose-500/15",
  cyan: "bg-cyan-500/15",
  orange: "bg-orange-500/15",
  slate: "bg-slate-500/15",
  emerald: "bg-emerald-500/15",
  indigo: "bg-indigo-500/15",
  pink: "bg-pink-500/15",
};

export const TAG_COLOR_TEXT: Record<string, string> = {
  blue: "text-blue-300 [[data-theme=light]_&]:text-blue-900",
  purple: "text-purple-300 [[data-theme=light]_&]:text-purple-900",
  amber: "text-amber-300 [[data-theme=light]_&]:text-amber-900",
  rose: "text-rose-300 [[data-theme=light]_&]:text-rose-900",
  cyan: "text-cyan-300 [[data-theme=light]_&]:text-cyan-900",
  orange: "text-orange-300 [[data-theme=light]_&]:text-orange-900",
  slate: "text-slate-300 [[data-theme=light]_&]:text-slate-900",
  emerald: "text-emerald-300 [[data-theme=light]_&]:text-emerald-900",
  indigo: "text-indigo-300 [[data-theme=light]_&]:text-indigo-900",
  pink: "text-pink-300 [[data-theme=light]_&]:text-pink-900",
};

export const TAG_COLOR_BORDER: Record<string, string> = {
  blue: "border-blue-500/30",
  purple: "border-purple-500/30",
  amber: "border-amber-500/30",
  rose: "border-rose-500/30",
  cyan: "border-cyan-500/30",
  orange: "border-orange-500/30",
  slate: "border-slate-500/30",
  emerald: "border-emerald-500/30",
  indigo: "border-indigo-500/30",
  pink: "border-pink-500/30",
};

export const TAG_COLOR_DOT: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  orange: "bg-orange-500",
  slate: "bg-slate-500",
  emerald: "bg-emerald-500",
  indigo: "bg-indigo-500",
  pink: "bg-pink-500",
};
