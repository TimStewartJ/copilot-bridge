import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DS } from "./tokens";

type Rgb = readonly [number, number, number];
type Theme = "dark" | "light";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const darkBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
const lightBlock = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
if (!darkBlock || !lightBlock) throw new Error("Missing design theme palettes");
const blocks: Record<Theme, string> = { dark: darkBlock, light: lightBlock };
const surfaces = ["surface-canvas", "surface-pane", "surface-group", "surface-inset", "surface-overlay", "surface-selected"] as const;
const textRoles = ["text-primary", "text-secondary", "text-muted", "text-faint", "accent", "info", "success", "warning", "error", "agent"] as const;
const stateRoles = ["accent", "info", "success", "warning", "error", "agent"] as const;
const identities = ["blue", "cyan", "emerald", "amber", "orange", "rose", "pink", "purple", "indigo", "slate"] as const;
const BADGE_SURFACE: Record<(typeof stateRoles)[number], string> = {
  accent: "accent-surface",
  info: "info-surface",
  success: "success-surface",
  warning: "warning-surface",
  error: "error-surface",
  agent: "agent-muted",
};

function palette(theme: Theme): Map<string, string> {
  return new Map([...blocks[theme].matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function value(colors: Map<string, string>, name: string): string {
  const result = colors.get(name);
  if (!result) throw new Error(`Missing theme role ${name}`);
  return result;
}

function rgb(hex: string): Rgb {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque hex colour, received ${hex}`);
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function luminance(color: Rgb): number {
  const channels = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: Rgb, second: Rgb): number {
  const one = luminance(first);
  const two = luminance(second);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

function blend(color: Rgb, alpha: number, background: Rgb): Rgb {
  return [
    color[0] * alpha + background[0] * (1 - alpha),
    color[1] * alpha + background[1] * (1 - alpha),
    color[2] * alpha + background[2] * (1 - alpha),
  ];
}

function rgba(colors: Map<string, string>, name: string): { color: Rgb; alpha: number } {
  const source = value(colors, name);
  const channels = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(source);
  if (!channels) throw new Error(`Expected rgba surface for ${name}, received ${source}`);
  return { color: [Number(channels[1]), Number(channels[2]), Number(channels[3])], alpha: Number(channels[4]) };
}

function tinted(colors: Map<string, string>, role: (typeof stateRoles)[number], background: Rgb): Rgb {
  const surface = rgba(colors, BADGE_SURFACE[role]);
  return blend(surface.color, surface.alpha, background);
}

/** APCA lightness contrast (SAPC 0.0.98G), used as a floor for light text on dark surfaces. */
function apca(text: Rgb, background: Rgb): number {
  const y = (color: Rgb) => {
    const [r, g, b] = color.map((channel) => (channel / 255) ** 2.4);
    const raw = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    return raw > 0.022 ? raw : raw + (0.022 - raw) ** 1.414;
  };
  const t = y(text);
  const b = y(background);
  const sapc = b > t ? (b ** 0.56 - t ** 0.57) * 1.14 : (b ** 0.65 - t ** 0.62) * 1.14;
  if (Math.abs(sapc) < 0.1) return 0;
  return Math.abs((sapc > 0 ? sapc - 0.027 : sapc + 0.027) * 100);
}

describe.each(["dark", "light"] as const)("%s surface hierarchy", (theme) => {
  const colors = palette(theme);

  it("keeps every enabled text role readable on every surface", () => {
    for (const foreground of textRoles) {
      for (const background of surfaces) {
        expect(contrast(rgb(value(colors, foreground)), rgb(value(colors, background))), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps state badges readable after their tint is composed over a selected row", () => {
    for (const background of surfaces) {
      for (const role of stateRoles) {
        const backdrop = tinted(colors, role, rgb(value(colors, background)));
        expect(contrast(rgb(value(colors, role)), backdrop), `${role} badge on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps state glyphs visible as graphics on every surface", () => {
    for (const role of stateRoles) {
      for (const background of surfaces) {
        expect(contrast(rgb(value(colors, `icon-${role}`)), rgb(value(colors, background))), `icon-${role} on ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps text levels far enough apart to read as different levels", () => {
    const step = (a: string, b: string) => contrast(rgb(value(colors, a)), rgb(value(colors, b)));
    expect(step("text-primary", "text-secondary"), "primary vs secondary").toBeGreaterThanOrEqual(1.4);
    expect(step("text-secondary", "text-faint"), "secondary vs faint").toBeGreaterThanOrEqual(1.4);
    expect(step("text-muted", "text-faint"), "muted vs faint").toBeGreaterThanOrEqual(1.4);
  });

  it("separates surface levels and draws visible lines", () => {
    const step = (a: string, b: string) => contrast(rgb(value(colors, a)), rgb(value(colors, b)));
    expect(step("surface-canvas", "surface-pane"), "canvas vs pane").toBeGreaterThanOrEqual(1.05);
    expect(step("surface-pane", "surface-group"), "pane vs group").toBeGreaterThanOrEqual(1.08);
    expect(step("surface-group", "surface-inset"), "group vs inset").toBeGreaterThanOrEqual(1.05);
    expect(step("surface-group", "surface-selected"), "group vs selected").toBeGreaterThanOrEqual(1.25);
    expect(step("surface-edge", "surface-group"), "surface edge on group").toBeGreaterThanOrEqual(1.4);
    expect(step("border", "surface-group"), "border on group").toBeGreaterThanOrEqual(1.3);
    expect(step("border-subtle", "surface-group"), "row divider on group").toBeGreaterThanOrEqual(1.1);
  });

  it("keeps identity swatches visible and tag names readable on their tint", () => {
    for (const identity of identities) {
      const swatch = rgb(value(colors, `identity-${identity}`));
      const text = rgb(value(colors, `identity-${identity}-text`));
      for (const background of surfaces) {
        const surface = rgb(value(colors, background));
        expect(contrast(swatch, surface), `${identity} swatch on ${background}`).toBeGreaterThanOrEqual(2.5);
        expect(contrast(text, blend(swatch, 0.12, surface)), `${identity} tag on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("gives inputs a visible boundary and gives groups a different tone from panes", () => {
    expect(contrast(rgb(value(colors, "control-edge")), rgb(value(colors, "surface-inset")))).toBeGreaterThanOrEqual(3);
    expect(value(colors, "surface-pane")).not.toBe(value(colors, "surface-group"));
    expect(value(colors, "surface-pane")).not.toBe(value(colors, "surface-selected"));
    expect(value(colors, "surface-canvas")).not.toBe(value(colors, "surface-group"));
  });
});

describe("dark theme perceptual contrast", () => {
  const colors = palette("dark");

  it("keeps secondary and faint text above the APCA floor for small text on a group", () => {
    const group = rgb(value(colors, "surface-group"));
    expect(apca(rgb(value(colors, "text-secondary")), group)).toBeGreaterThanOrEqual(70);
    expect(apca(rgb(value(colors, "text-faint")), group)).toBeGreaterThanOrEqual(45);
  });
});

describe("surface recipes", () => {
  it("uses opaque semantic roles instead of parent-dependent surface opacity", () => {
    for (const recipe of [DS.surface.canvas, DS.surface.pane, DS.surface.group, DS.surface.inset, DS.surface.selected, DS.surface.floating, DS.surface.dialog]) {
      expect(recipe).toContain("bg-surface-");
      expect(recipe).not.toMatch(/bg-[^\s]+\/\d/);
    }
    expect(DS.surface.group).not.toMatch(/\bshadow(?:-|\s|$)/);
    expect(DS.field.input).toContain("border-control-edge");
  });
});
