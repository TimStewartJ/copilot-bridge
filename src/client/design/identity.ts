/**
 * Identity colours: the colour a user picks for a group or a tag. Each name maps to a themed
 * `identity-*` variable in index.css, so both themes keep their contrast. These mark identity beside
 * a name and are never used for state.
 *
 * Every class is written out in full because Tailwind finds classes by scanning source text.
 */

export const IDENTITY_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate", "emerald", "indigo", "pink",
] as const;

export type IdentityColor = (typeof IDENTITY_COLORS)[number];

/** A swatch, bar or colour choice filled with the identity colour. */
export const IDENTITY_FILL: Record<IdentityColor, string> = {
  blue: "bg-identity-blue",
  purple: "bg-identity-purple",
  amber: "bg-identity-amber",
  rose: "bg-identity-rose",
  cyan: "bg-identity-cyan",
  orange: "bg-identity-orange",
  slate: "bg-identity-slate",
  emerald: "bg-identity-emerald",
  indigo: "bg-identity-indigo",
  pink: "bg-identity-pink",
};

/** The tint behind a tag's name. Paired with IDENTITY_TEXT, which is checked against it. */
export const IDENTITY_TINT: Record<IdentityColor, string> = {
  blue: "bg-identity-blue/12",
  purple: "bg-identity-purple/12",
  amber: "bg-identity-amber/12",
  rose: "bg-identity-rose/12",
  cyan: "bg-identity-cyan/12",
  orange: "bg-identity-orange/12",
  slate: "bg-identity-slate/12",
  emerald: "bg-identity-emerald/12",
  indigo: "bg-identity-indigo/12",
  pink: "bg-identity-pink/12",
};

export const IDENTITY_TEXT: Record<IdentityColor, string> = {
  blue: "text-identity-blue-text",
  purple: "text-identity-purple-text",
  amber: "text-identity-amber-text",
  rose: "text-identity-rose-text",
  cyan: "text-identity-cyan-text",
  orange: "text-identity-orange-text",
  slate: "text-identity-slate-text",
  emerald: "text-identity-emerald-text",
  indigo: "text-identity-indigo-text",
  pink: "text-identity-pink-text",
};

export const IDENTITY_EDGE: Record<IdentityColor, string> = {
  blue: "border-identity-blue/30",
  purple: "border-identity-purple/30",
  amber: "border-identity-amber/30",
  rose: "border-identity-rose/30",
  cyan: "border-identity-cyan/30",
  orange: "border-identity-orange/30",
  slate: "border-identity-slate/30",
  emerald: "border-identity-emerald/30",
  indigo: "border-identity-indigo/30",
  pink: "border-identity-pink/30",
};

function isIdentityColor(color: string | undefined | null): color is IdentityColor {
  return typeof color === "string" && (IDENTITY_COLORS as readonly string[]).includes(color);
}

/** Resolves a stored colour name, falling back to slate for unknown or missing values. */
export function identityColor(color: string | undefined | null): IdentityColor {
  return isIdentityColor(color) ? color : "slate";
}
