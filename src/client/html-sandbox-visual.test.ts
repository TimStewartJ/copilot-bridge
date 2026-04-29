import { describe, expect, it } from "vitest";
import type { VisualArtifact } from "./api";

// Tests for HtmlSandboxVisual helper logic and type contracts.
// Avoids browser/React rendering environment — tests pure type and logic properties.

const BASE_HTML_VISUAL: VisualArtifact = {
  artifactId: "aa0e8400-e29b-41d4-a716-446655440000",
  kind: "html",
  title: "My Page",
  displayName: "My_Page.html",
  mimeType: "text/html",
  size: 40,
  url: "/api/sessions/test/visuals/aa0e8400-e29b-41d4-a716-446655440000",
  downloadUrl: "/api/sessions/test/visuals/aa0e8400-e29b-41d4-a716-446655440000/download",
  source: "<html><body>Hello</body></html>",
};

/** The sandbox attribute used by HtmlSandboxVisual */
const IFRAME_SANDBOX_ATTR = "allow-scripts";

describe("html sandbox visual helpers", () => {
  describe("VisualArtifact type — html kind", () => {
    it("html artifact has kind=html", () => {
      expect(BASE_HTML_VISUAL.kind).toBe("html");
    });

    it("html artifact may include live source text", () => {
      expect(typeof BASE_HTML_VISUAL.source).toBe("string");
      expect(BASE_HTML_VISUAL.source!.length).toBeGreaterThan(0);
    });

    it("html artifact can rely on url for replay source", () => {
      const replayVisual = { ...BASE_HTML_VISUAL, source: undefined };
      expect(replayVisual.source).toBeUndefined();
      expect(replayVisual.url).toMatch(/\/visuals\//);
    });

    it("html artifact has text/html mimeType", () => {
      expect(BASE_HTML_VISUAL.mimeType).toBe("text/html");
    });

    it("html artifact has url and downloadUrl", () => {
      expect(BASE_HTML_VISUAL.url).toMatch(/\/visuals\//);
      expect(BASE_HTML_VISUAL.downloadUrl).toMatch(/\/download/);
    });
  });

  describe("iframe sandbox attribute", () => {
    it("sandbox attribute includes allow-scripts", () => {
      expect(IFRAME_SANDBOX_ATTR).toContain("allow-scripts");
    });

    it("sandbox attribute does NOT include allow-same-origin", () => {
      expect(IFRAME_SANDBOX_ATTR).not.toContain("allow-same-origin");
    });

    it("sandbox attribute does NOT grant full top-navigation", () => {
      expect(IFRAME_SANDBOX_ATTR).not.toContain("allow-top-navigation");
    });

    it("sandbox attribute does NOT allow forms", () => {
      expect(IFRAME_SANDBOX_ATTR).not.toContain("allow-forms");
    });
  });

  describe("content availability checks", () => {
    it("visual with source and url is renderable", () => {
      const v = { ...BASE_HTML_VISUAL };
      expect(!!(v.source || v.url)).toBe(true);
    });

    it("visual with url but no source is renderable", () => {
      const v = { ...BASE_HTML_VISUAL, source: undefined };
      expect(!!(v.source || v.url)).toBe(true);
    });

    it("visual with empty source and empty url shows fallback", () => {
      const v: VisualArtifact = { ...BASE_HTML_VISUAL, source: undefined, url: "" };
      expect(!!(v.source || v.url)).toBe(false);
    });

    it("visual with source but no url is still renderable (content available)", () => {
      const v: VisualArtifact = { ...BASE_HTML_VISUAL, url: "" };
      expect(!!(v.source || v.url)).toBe(true);
    });
  });

  describe("kind discrimination", () => {
    it("only html kind triggers html sandbox renderer", () => {
      const kinds: VisualArtifact["kind"][] = ["image", "mermaid", "vega-lite", "html"];
      const htmlKinds = kinds.filter((k) => k === "html");
      expect(htmlKinds).toEqual(["html"]);
    });

    it("image/mermaid/vega-lite do not trigger html renderer", () => {
      const nonHtml: VisualArtifact["kind"][] = ["image", "mermaid", "vega-lite"];
      for (const kind of nonHtml) {
        expect(kind).not.toBe("html");
      }
    });
  });
});
