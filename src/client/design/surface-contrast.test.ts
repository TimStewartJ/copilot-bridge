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
const textRoles = ["text-primary", "text-secondary", "text-muted", "text-faint", "accent", "info", "success", "warning", "error"] as const;

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

function tinted(colors: Map<string, string>, role: "accent" | "info" | "success" | "warning" | "error", background: Rgb): Rgb {
  if (role !== "accent" && role !== "info") return blend(rgb(value(colors, role)), 0.12, background);
  const source = value(colors, `${role}-surface`);
  const channels = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(source);
  if (!channels) throw new Error(`Expected rgba badge surface, received ${source}`);
  return blend([Number(channels[1]), Number(channels[2]), Number(channels[3])], Number(channels[4]), background);
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
      for (const role of ["accent", "info", "success", "warning", "error"] as const) {
        const backdrop = tinted(colors, role, rgb(value(colors, background)));
        expect(contrast(rgb(value(colors, role)), backdrop), `${role} badge on ${background}`).toBeGreaterThanOrEqual(4.5);
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
