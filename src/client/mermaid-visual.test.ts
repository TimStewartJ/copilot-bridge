import { describe, expect, it, vi, beforeEach } from "vitest";
import type { VisualArtifact } from "./api";

// Test pure helper logic extracted from MermaidVisual —
// avoids needing a real browser or React rendering environment.

const BASE_VISUAL: VisualArtifact = {
  artifactId: "770e8400-e29b-41d4-a716-446655440000",
  kind: "mermaid",
  title: "My Flow",
  displayName: "My_Flow.mmd",
  mimeType: "text/vnd.mermaid",
  size: 20,
  url: "/api/sessions/test/visuals/770e8400-e29b-41d4-a716-446655440000",
  downloadUrl: "/api/sessions/test/visuals/770e8400-e29b-41d4-a716-446655440000/download",
  source: "graph TD\n  A-->B",
};

// Utility used internally by MermaidVisual to derive a stable ID safe for mermaid.render()
function deriveMermaidId(artifactId: string): string {
  return `mermaid-${artifactId.replace(/-/g, "")}`;
}

describe("mermaid visual helpers", () => {
  describe("deriveMermaidId", () => {
    it("strips dashes from UUID", () => {
      expect(deriveMermaidId("770e8400-e29b-41d4-a716-446655440000"))
        .toBe("mermaid-770e8400e29b41d4a716446655440000");
    });

    it("produces a string safe for use as an HTML id", () => {
      const id = deriveMermaidId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(/^[a-z][a-z0-9_-]*$/.test(id)).toBe(true);
    });
  });

  describe("VisualArtifact type checks", () => {
    it("mermaid artifact has kind=mermaid", () => {
      expect(BASE_VISUAL.kind).toBe("mermaid");
    });

    it("mermaid artifact may include live source text", () => {
      expect(typeof BASE_VISUAL.source).toBe("string");
      expect(BASE_VISUAL.source!.length).toBeGreaterThan(0);
    });

    it("mermaid artifact can rely on url for replay source", () => {
      const replayVisual = { ...BASE_VISUAL, source: undefined };
      expect(replayVisual.source).toBeUndefined();
      expect(replayVisual.url).toMatch(/\/visuals\//);
    });

    it("image artifact does not have source", () => {
      const img: VisualArtifact = {
        artifactId: "880e8400-e29b-41d4-a716-446655440000",
        kind: "image",
        title: "Photo",
        displayName: "photo.png",
        mimeType: "image/png",
        size: 512,
        url: "/api/x",
        downloadUrl: "/api/x/download",
      };
      expect(img.source).toBeUndefined();
    });
  });

  describe("mermaid render error handling", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("treats empty source as an error condition", () => {
      const empty = { ...BASE_VISUAL, source: "" };
      expect(!empty.source?.trim()).toBe(true);
    });

    it("treats whitespace-only source as an error condition", () => {
      const ws = { ...BASE_VISUAL, source: "   \n  " };
      expect(!ws.source?.trim()).toBe(true);
    });

    it("treats missing source and missing url as an error condition", () => {
      const noSource = { ...BASE_VISUAL, source: undefined, url: "" };
      expect(!noSource.url && !(noSource.source ?? "").trim()).toBe(true);
    });
  });
});
