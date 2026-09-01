import { describe, expect, it } from "vitest";
import { makeMermaidSvgResponsive } from "./components/MermaidVisual";
import { prepareResponsiveVegaSpec } from "./components/VegaLiteVisual";

const VALID_SPEC = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  mark: "bar",
  data: { values: [{ a: "A", b: 28 }, { a: "B", b: 55 }] },
  encoding: {
    x: { field: "a", type: "ordinal" },
    y: { field: "b", type: "quantitative" },
  },
};

describe("makeMermaidSvgResponsive", () => {
  it("removes fixed svg dimensions and adds responsive sizing", () => {
    const svg = '<svg id="graph" width="420" height="180" viewBox="0 0 420 180"><g /></svg>';
    const responsive = makeMermaidSvgResponsive(svg);

    expect(responsive).toContain('<svg id="graph" viewBox="0 0 420 180" style="width: 100%; max-width: 100%; height: auto;">');
    expect(responsive).not.toContain('width="420"');
    expect(responsive).not.toContain('height="180"');
  });

  it("preserves existing svg styles while appending responsive sizing", () => {
    const svg = '<svg style="max-width: 320px;" width="320" height="100"><g /></svg>';
    const responsive = makeMermaidSvgResponsive(svg);

    expect(responsive).toContain('style="max-width: 320px; width: 100%; max-width: 100%; height: auto;"');
  });

  it("keeps fixed dimensions when an svg has no viewBox to preserve aspect ratio", () => {
    const svg = '<svg width="320" height="100"><g /></svg>';
    const responsive = makeMermaidSvgResponsive(svg);

    expect(responsive).toContain('width="320"');
    expect(responsive).toContain('height="100"');
    expect(responsive).toContain('style="width: 100%; max-width: 100%; height: auto;"');
  });

  it("focus mode scales viewBox SVGs against both available axes", () => {
    const svg = '<svg id="graph" width="420" height="180" viewBox="0 0 420 180"><g /></svg>';
    const responsive = makeMermaidSvgResponsive(svg, "focus");

    expect(responsive).toContain('<svg id="graph" viewBox="0 0 420 180" style="width: 100%; height: 100%; max-width: 100%; max-height: 100%;">');
    expect(responsive).not.toContain('width="420"');
    expect(responsive).not.toContain('height="180"');
  });

  it("focus mode preserves fixed dimensions when an SVG has no viewBox", () => {
    const svg = '<svg width="320" height="100"><g /></svg>';
    const responsive = makeMermaidSvgResponsive(svg, "focus");

    expect(responsive).toContain('width="320"');
    expect(responsive).toContain('height="100"');
    expect(responsive).toContain('style="max-width: 100%; max-height: 100%; width: auto; height: auto;"');
  });
});

describe("prepareResponsiveVegaSpec", () => {
  it("injects responsive dimensions and autosize for single-view specs without explicit dimensions", () => {
    const sourceSpec = { ...VALID_SPEC };
    const result = prepareResponsiveVegaSpec(sourceSpec, { width: 640 });

    expect(result.injectedWidth).toBe(true);
    expect(result.injectedHeight).toBe(true);
    expect(result.skippedCompound).toBe(false);
    expect(result.spec.width).toBe(640);
    expect(result.spec.height).toBe(358);
    expect(result.spec.autosize).toEqual({ type: "fit", contains: "padding" });
    expect(sourceSpec).not.toHaveProperty("width");
    expect(sourceSpec).not.toHaveProperty("height");
  });

  it("preserves explicit dimensions and autosize", () => {
    const result = prepareResponsiveVegaSpec({
      ...VALID_SPEC,
      width: 240,
      height: 120,
      autosize: { type: "pad" },
    }, { width: 640 });

    expect(result.injectedWidth).toBe(false);
    expect(result.injectedHeight).toBe(false);
    expect(result.spec.width).toBe(240);
    expect(result.spec.height).toBe(120);
    expect(result.spec.autosize).toEqual({ type: "pad" });
  });

  it("uses view config defaults for compound specs instead of top-level dimensions", () => {
    const result = prepareResponsiveVegaSpec({
      hconcat: [VALID_SPEC, VALID_SPEC],
    }, { width: 640 });

    expect(result.skippedCompound).toBe(true);
    expect(result.injectedWidth).toBe(false);
    expect(result.injectedHeight).toBe(false);
    expect(result.injectedViewConfig).toBe(true);
    expect(result.spec).not.toHaveProperty("width");
    expect(result.spec).not.toHaveProperty("autosize");
    expect(result.spec.config).toEqual({
      view: {
        continuousWidth: 640,
        continuousHeight: 358,
      },
    });
  });

  it("does not inject dimensions before a container width is known", () => {
    const result = prepareResponsiveVegaSpec(VALID_SPEC, { width: 0 });

    expect(result.injectedWidth).toBe(false);
    expect(result.injectedHeight).toBe(false);
    expect(result.injectedViewConfig).toBe(false);
    expect(result.spec).not.toHaveProperty("width");
    expect(result.spec).not.toHaveProperty("height");
  });

  it("caps injected focus-mode height to the available viewport height", () => {
    const result = prepareResponsiveVegaSpec(VALID_SPEC, { width: 1400, height: 500, mode: "focus" });

    expect(result.injectedWidth).toBe(true);
    expect(result.injectedHeight).toBe(true);
    expect(result.spec.width).toBe(1400);
    expect(result.spec.height).toBe(500);
    expect(result.spec.autosize).toEqual({ type: "fit", contains: "padding" });
  });

  it("preserves existing compound view config values", () => {
    const result = prepareResponsiveVegaSpec({
      hconcat: [VALID_SPEC, VALID_SPEC],
      config: { view: { continuousWidth: 240, continuousHeight: 120 } },
    }, { width: 900, height: 700, mode: "focus" });

    expect(result.skippedCompound).toBe(true);
    expect(result.injectedViewConfig).toBe(false);
    expect(result.spec.config).toEqual({ view: { continuousWidth: 240, continuousHeight: 120 } });
  });
});
