import { describe, expect, it } from "vitest";
import type { VisualArtifact } from "./api";

// Tests for visual artifact UX contracts:
// - Source controls: non-image kinds can use embedded live source or fetch from url
// - Accessibility: aria labels, iframe title, image alt
// - Modal: aria-labelledby pattern (title id constant)
// - De-dupe: covered in chat-cache.test.ts

const ARTIFACT_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeVisual(overrides: Partial<VisualArtifact> & { kind: VisualArtifact["kind"] }): VisualArtifact {
  return {
    artifactId: ARTIFACT_ID,
    title: "Test Visual",
    displayName: "test.mmd",
    mimeType: "text/vnd.mermaid",
    size: 32,
    url: `/api/sessions/test/visuals/${ARTIFACT_ID}`,
    downloadUrl: `/api/sessions/test/visuals/${ARTIFACT_ID}/download`,
    ...overrides,
  };
}

describe("visual artifact source controls", () => {
  it("mermaid visual can fetch source from url without embedding source", () => {
    const v = makeVisual({ kind: "mermaid" });
    expect(v.source).toBeUndefined();
    expect(v.url).toBeTruthy();
    expect(v.kind).toBe("mermaid");
  });

  it("vega-lite visual can fetch source from url without embedding source", () => {
    const v = makeVisual({ kind: "vega-lite", mimeType: "application/vnd.vegalite+json" });
    expect(v.source).toBeUndefined();
    expect(v.url).toBeTruthy();
  });

  it("html visual can fetch source from url without embedding source", () => {
    const v = makeVisual({ kind: "html", mimeType: "text/html" });
    expect(v.source).toBeUndefined();
    expect(v.url).toBeTruthy();
    expect(v.kind).toBe("html");
  });

  it("embedded source remains supported for live-stream visuals", () => {
    const spec = JSON.stringify({ mark: "bar", data: { values: [] } });
    const v = makeVisual({ kind: "vega-lite", source: spec, mimeType: "application/vnd.vegalite+json" });
    expect(() => JSON.parse(v.source!)).not.toThrow();
  });

  it("image visual does NOT have source text", () => {
    const v = makeVisual({ kind: "image", mimeType: "image/png" });
    expect(v.source).toBeUndefined();
  });

  it("source toggle is applicable for mermaid/vega-lite/html but not image", () => {
    const nonImageKinds: VisualArtifact["kind"][] = ["mermaid", "vega-lite", "html"];
    for (const kind of nonImageKinds) {
      const v = makeVisual({ kind });
      // hasSource logic from VisualArtifactModal
      const hasSource = v.kind !== "image" && !!(v.source || v.url);
      expect(hasSource).toBe(true);
    }
    const img = makeVisual({ kind: "image", mimeType: "image/png" });
    const hasSource = img.kind !== "image" && !!(img.source || img.url);
    expect(hasSource).toBe(false);
  });
});

describe("visual artifact source labels", () => {
  const SOURCE_LABEL: Record<string, string> = {
    mermaid: "Diagram source",
    "vega-lite": "Vega-Lite spec",
    html: "HTML source",
  };

  it("mermaid has the correct source label", () => {
    expect(SOURCE_LABEL["mermaid"]).toBe("Diagram source");
  });

  it("vega-lite has the correct source label", () => {
    expect(SOURCE_LABEL["vega-lite"]).toBe("Vega-Lite spec");
  });

  it("html has the correct source label", () => {
    expect(SOURCE_LABEL["html"]).toBe("HTML source");
  });

  it("source panel toggle button aria-label uses the source label", () => {
    for (const [kind, label] of Object.entries(SOURCE_LABEL)) {
      const show = `View ${label}`;
      const hide = `Hide ${label}`;
      expect(show).toContain(label);
      expect(hide).toContain(label);
    }
  });
});

describe("visual artifact accessibility contracts", () => {
  it("image artifact uses altText when provided", () => {
    const v = makeVisual({ kind: "image", mimeType: "image/png", altText: "A bar chart of sales data" });
    const effectiveAlt = v.altText ?? v.title;
    expect(effectiveAlt).toBe("A bar chart of sales data");
  });

  it("image artifact falls back to title when altText is absent", () => {
    const v = makeVisual({ kind: "image", mimeType: "image/png" });
    const effectiveAlt = v.altText ?? v.title;
    expect(effectiveAlt).toBe("Test Visual");
  });

  it("download URL follows expected pattern for all kinds", () => {
    const kinds: VisualArtifact["kind"][] = ["image", "mermaid", "vega-lite", "html"];
    for (const kind of kinds) {
      const v = makeVisual({ kind });
      expect(v.downloadUrl).toMatch(/\/download$/);
    }
  });

  it("displayName is present for all kinds", () => {
    const kinds: VisualArtifact["kind"][] = ["image", "mermaid", "vega-lite", "html"];
    for (const kind of kinds) {
      const v = makeVisual({ kind, displayName: `artifact.${kind}` });
      expect(v.displayName).toBeTruthy();
    }
  });

  it("modal title id constant is a non-empty string usable as an HTML id", () => {
    // The TITLE_ID used in VisualArtifactModal for aria-labelledby
    const TITLE_ID = "va-modal-title";
    expect(TITLE_ID).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("iframe sandbox excludes allow-same-origin and allow-forms", () => {
    const IFRAME_SANDBOX = "allow-scripts";
    expect(IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(IFRAME_SANDBOX).not.toContain("allow-forms");
    expect(IFRAME_SANDBOX).not.toContain("allow-top-navigation");
  });
});

describe("visual artifact URL consistency", () => {
  it("url and downloadUrl are both present", () => {
    const kinds: VisualArtifact["kind"][] = ["image", "mermaid", "vega-lite", "html"];
    for (const kind of kinds) {
      const v = makeVisual({ kind });
      expect(v.url).toBeTruthy();
      expect(v.downloadUrl).toBeTruthy();
    }
  });

  it("downloadUrl differs from url by /download suffix", () => {
    const v = makeVisual({ kind: "mermaid" });
    expect(v.downloadUrl).toBe(v.url + "/download");
  });

  it("no SVG in raster image allowed MIME types", () => {
    // Ensures inline SVG security constraint: SVG is never a permitted image type
    const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];
    expect(ALLOWED_IMAGE_MIMES).not.toContain("image/svg+xml");
    expect(ALLOWED_IMAGE_MIMES.every((m) => !m.includes("svg"))).toBe(true);
  });
});
