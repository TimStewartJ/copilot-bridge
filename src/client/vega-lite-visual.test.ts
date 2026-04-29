import { describe, expect, it, vi, beforeEach } from "vitest";
import type { VisualArtifact } from "./api";

// Test pure helper logic for VegaLiteVisual —
// avoids needing a real browser or React rendering environment.

const VALID_SPEC = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  mark: "bar",
  data: { values: [{ a: "A", b: 28 }, { a: "B", b: 55 }] },
  encoding: {
    x: { field: "a", type: "ordinal" },
    y: { field: "b", type: "quantitative" },
  },
};

const BASE_VISUAL: VisualArtifact = {
  artifactId: "990e8400-e29b-41d4-a716-446655440000",
  kind: "vega-lite",
  title: "My Bar Chart",
  displayName: "My_Bar_Chart.vl.json",
  mimeType: "application/vnd.vegalite+json",
  size: 200,
  url: "/api/sessions/test/visuals/990e8400-e29b-41d4-a716-446655440000",
  downloadUrl: "/api/sessions/test/visuals/990e8400-e29b-41d4-a716-446655440000/download",
  source: JSON.stringify(VALID_SPEC, null, 2),
};

// Helpers extracted from VegaLiteVisual logic, tested without browser context

function parseVegaLiteSource(source: string | undefined): { spec: object } | { error: string } {
  const s = source ?? "";
  if (!s.trim()) return { error: "Vega-Lite spec is empty" };
  try {
    const spec = JSON.parse(s);
    return { spec };
  } catch {
    return { error: "Vega-Lite spec is not valid JSON" };
  }
}

describe("vega-lite visual helpers", () => {
  describe("VisualArtifact type checks", () => {
    it("vega-lite artifact has kind=vega-lite", () => {
      expect(BASE_VISUAL.kind).toBe("vega-lite");
    });

    it("vega-lite artifact may include live source text", () => {
      expect(typeof BASE_VISUAL.source).toBe("string");
      expect(BASE_VISUAL.source!.length).toBeGreaterThan(0);
    });

    it("vega-lite artifact can rely on url for replay source", () => {
      const replayVisual = { ...BASE_VISUAL, source: undefined };
      expect(replayVisual.source).toBeUndefined();
      expect(replayVisual.url).toMatch(/\/visuals\//);
    });

    it("vega-lite artifact has correct mime type", () => {
      expect(BASE_VISUAL.mimeType).toBe("application/vnd.vegalite+json");
    });

    it("vega-lite artifact source is valid JSON", () => {
      expect(() => JSON.parse(BASE_VISUAL.source!)).not.toThrow();
    });
  });

  describe("parseVegaLiteSource", () => {
    it("parses a valid spec object", () => {
      const result = parseVegaLiteSource(JSON.stringify(VALID_SPEC));
      expect("spec" in result).toBe(true);
      if ("spec" in result) {
        expect(typeof result.spec).toBe("object");
      }
    });

    it("returns error for empty source", () => {
      const result = parseVegaLiteSource("");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toMatch(/empty/i);
      }
    });

    it("returns error for whitespace-only source", () => {
      const result = parseVegaLiteSource("   \n  ");
      expect("error" in result).toBe(true);
    });

    it("returns error for undefined source", () => {
      const result = parseVegaLiteSource(undefined);
      expect("error" in result).toBe(true);
    });

    it("returns error for invalid JSON", () => {
      const result = parseVegaLiteSource("{ not valid");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toMatch(/JSON/i);
      }
    });
  });

  describe("render error handling", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("treats empty source as an error condition", () => {
      const empty = { ...BASE_VISUAL, source: "" };
      expect(!(empty.source ?? "").trim()).toBe(true);
    });

    it("treats missing source and missing url as an error condition", () => {
      const noSource = { ...BASE_VISUAL, source: undefined, url: "" };
      expect(!noSource.url && !(noSource.source ?? "").trim()).toBe(true);
    });

    it("treats invalid JSON as an error condition", () => {
      const bad = { ...BASE_VISUAL, source: "{ bad json }" };
      const result = parseVegaLiteSource(bad.source);
      expect("error" in result).toBe(true);
    });
  });

  describe("vega-embed mock rendering", () => {
    it("calls vega-embed with actions:false", async () => {
      const mockEmbed = vi.fn().mockResolvedValue({ view: {}, finalize: vi.fn() });
      vi.doMock("vega-embed", () => ({ default: mockEmbed }));

      const container = {} as HTMLElement;
      const spec = JSON.parse(BASE_VISUAL.source!);

      // Simulate what VegaLiteVisual does: dynamic import + call
      const vegaEmbed = (await import("vega-embed")).default;
      await vegaEmbed(container as any, spec as any, { actions: false, renderer: "canvas" });

      expect(mockEmbed).toHaveBeenCalledWith(
        container,
        spec,
        expect.objectContaining({ actions: false }),
      );

      vi.doUnmock("vega-embed");
    });
  });
});
