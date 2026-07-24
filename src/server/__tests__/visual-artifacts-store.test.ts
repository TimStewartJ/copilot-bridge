import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  HTML_MIME_TYPE,
  MERMAID_MIME_TYPE,
  MAX_HTML_SOURCE_BYTES,
  MAX_MERMAID_SOURCE_CHARS,
  isAllowedImageMime,
  isCanonicalArtifactId,
  loadVisualArtifactMetaForOwner,
  publishHtmlArtifact,
  publishMermaidArtifact,
  publishVisualArtifact,
  resolveVisualArtifactForOwner,
  sessionVisualOwner,
} from "../visual-artifacts.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("visual-artifacts: isAllowedImageMime", () => {
  it("allows all raster image types in the allow-list", () => {
    for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
      expect(isAllowedImageMime(mime)).toBe(true);
    }
  });

  it("rejects SVG", () => {
    expect(isAllowedImageMime("image/svg+xml")).toBe(false);
  });

  it("rejects arbitrary types", () => {
    expect(isAllowedImageMime("application/pdf")).toBe(false);
    expect(isAllowedImageMime("text/html")).toBe(false);
  });
});

describe("visual-artifacts: isCanonicalArtifactId", () => {
  it("accepts valid UUIDs", () => {
    expect(isCanonicalArtifactId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isCanonicalArtifactId("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(isCanonicalArtifactId("not-a-uuid")).toBe(false);
    expect(isCanonicalArtifactId("../evil")).toBe(false);
    expect(isCanonicalArtifactId("")).toBe(false);
  });
});

describe("publishVisualArtifact", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), "bridge-visual-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("publishes an image from a file path", () => {
    const copilotHome = makeTmpDir();
    const srcDir = makeTmpDir();
    const srcPath = join(srcDir, "chart.png");
    // Write minimal PNG header bytes
    writeFileSync(srcPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "My Chart",
      mimeType: "image/png",
      sourcePath: srcPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("image");
    expect(result.value.title).toBe("My Chart");
    expect(result.value.mimeType).toBe("image/png");
    expect(result.value.size).toBeGreaterThan(0);
    expect(result.value.url).toMatch(/\/visuals\//);
    expect(result.value.downloadUrl).toMatch(/\/download/);
    expect(result.value.metaUrl).toMatch(/\/meta/);
    expect(isCanonicalArtifactId(result.value.artifactId)).toBe(true);
  });

  it("publishes an image from base64 content", () => {
    const copilotHome = makeTmpDir();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const result = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "Inline Image",
      mimeType: "image/png",
      content: pngBytes.toString("base64"),
      displayName: "inline.png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.displayName).toBe("inline.png");
    expect(result.value.size).toBe(pngBytes.length);
  });

  it("stores metadata in a .meta.json file", () => {
    const copilotHome = makeTmpDir();
    const srcDir = makeTmpDir();
    const srcPath = join(srcDir, "photo.jpg");
    writeFileSync(srcPath, Buffer.from([0xff, 0xd8, 0xff]));

    const result = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "Photo",
      mimeType: "image/jpeg",
      sourcePath: srcPath,
      caption: "A nice photo",
      altText: "Photo alt",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const visualsDir = join(copilotHome, "session-state", SESSION_ID, "files", "visuals");
    const meta = JSON.parse(readFileSync(join(visualsDir, `${result.value.artifactId}.meta.json`), "utf-8"));
    expect(meta.kind).toBe("image");
    expect(meta.title).toBe("Photo");
    expect(meta.mimeType).toBe("image/jpeg");
    expect(meta.caption).toBe("A nice photo");
    expect(meta.altText).toBe("Photo alt");
  });

  it("rejects SVG mime type", () => {
    const copilotHome = makeTmpDir();
    const result = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "SVG",
      mimeType: "image/svg+xml",
      content: "",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/Unsupported/);
  });

  it("rejects when both path and content are provided", () => {
    const copilotHome = makeTmpDir();
    const result = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "T",
      mimeType: "image/png",
      sourcePath: "/some/path",
      content: "data",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/exactly one/);
  });

  it("rejects invalid sessionId", () => {
    const copilotHome = makeTmpDir();
    const result = publishVisualArtifact({
      copilotHome,
      sessionId: "bad-id",
      kind: "image",
      title: "T",
      mimeType: "image/png",
      content: "",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/sessionId/);
  });

  it("respects apiBasePath in generated URLs", () => {
    const copilotHome = makeTmpDir();
    const srcDir = makeTmpDir();
    const srcPath = join(srcDir, "img.png");
    writeFileSync(srcPath, Buffer.from([0x89, 0x50]));

    const result = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "T",
      mimeType: "image/png",
      sourcePath: srcPath,
      apiBasePath: "/staging/preview-abc/api",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toMatch(/^\/staging\/preview-abc\/api\//);
  });
});

describe("resolveVisualArtifactForOwner", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), "bridge-visual-resolve-"));
    tempDirs.push(dir);
    return dir;
  }

  it("resolves a published artifact", () => {
    const copilotHome = makeTmpDir();
    const srcDir = makeTmpDir();
    const srcPath = join(srcDir, "test.png");
    writeFileSync(srcPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const published = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "Test",
      mimeType: "image/png",
      sourcePath: srcPath,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const resolved = resolveVisualArtifactForOwner(
      copilotHome,
      sessionVisualOwner(SESSION_ID),
      published.value.artifactId,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mimeType).toBe("image/png");
    expect(resolved.value.displayName).toBe("test.png");
  });

  it("returns error for non-existent artifact", () => {
    const copilotHome = makeTmpDir();
    const result = resolveVisualArtifactForOwner(
      copilotHome,
      sessionVisualOwner(SESSION_ID),
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result.ok).toBe(false);
  });

  it("returns error for invalid artifactId", () => {
    const copilotHome = makeTmpDir();
    const result = resolveVisualArtifactForOwner(copilotHome, sessionVisualOwner(SESSION_ID), "../evil");
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/invalid/);
  });
});

describe("loadVisualArtifactMetaForOwner", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), "bridge-visual-meta-"));
    tempDirs.push(dir);
    return dir;
  }

  it("loads metadata for a published artifact", () => {
    const copilotHome = makeTmpDir();
    const srcDir = makeTmpDir();
    const srcPath = join(srcDir, "img.webp");
    writeFileSync(srcPath, Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const published = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "WebP Image",
      mimeType: "image/webp",
      sourcePath: srcPath,
      caption: "webp caption",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const meta = loadVisualArtifactMetaForOwner(
      copilotHome,
      sessionVisualOwner(SESSION_ID),
      published.value.artifactId,
    );
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.value.title).toBe("WebP Image");
    expect(meta.value.mimeType).toBe("image/webp");
    expect(meta.value.caption).toBe("webp caption");
  });
});

describe("publishMermaidArtifact", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), "bridge-mermaid-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("publishes a mermaid diagram and returns structured artifact", () => {
    const copilotHome = makeTmpDir();
    const source = "graph TD\n  A-->B";

    const result = publishMermaidArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "My Flow",
      source,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("mermaid");
    expect(result.value.title).toBe("My Flow");
    expect(result.value.mimeType).toBe(MERMAID_MIME_TYPE);
    expect(result.value.source).toBe(source);
    expect(result.value.size).toBeGreaterThan(0);
    expect(result.value.url).toMatch(/\/visuals\//);
    expect(result.value.downloadUrl).toMatch(/\/download/);
    expect(result.value.metaUrl).toMatch(/\/meta/);
    expect(isCanonicalArtifactId(result.value.artifactId)).toBe(true);
  });

  it("stores the source in a .mmd file and in metadata", () => {
    const copilotHome = makeTmpDir();
    const source = "sequenceDiagram\n  A->>B: Hello";

    const result = publishMermaidArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Sequence",
      source,
      caption: "My sequence",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const visualsDir = join(copilotHome, "session-state", SESSION_ID, "files", "visuals");
    const fileContent = readFileSync(join(visualsDir, `${result.value.artifactId}.mmd`), "utf-8");
    expect(fileContent).toBe(source);

    const meta = JSON.parse(readFileSync(join(visualsDir, `${result.value.artifactId}.meta.json`), "utf-8"));
    expect(meta.kind).toBe("mermaid");
    expect(meta.source).toBe(source);
    expect(meta.caption).toBe("My sequence");
    expect(meta.mimeType).toBe(MERMAID_MIME_TYPE);
  });

  it("rejects empty source", () => {
    const copilotHome = makeTmpDir();
    const result = publishMermaidArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Empty",
      source: "   ",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/empty/);
  });

  it("rejects source exceeding the character limit", () => {
    const copilotHome = makeTmpDir();
    const result = publishMermaidArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Huge",
      source: "A".repeat(MAX_MERMAID_SOURCE_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/character limit/);
  });

  it("rejects invalid sessionId", () => {
    const copilotHome = makeTmpDir();
    const result = publishMermaidArtifact({
      copilotHome,
      sessionId: "bad-id",
      title: "T",
      source: "graph TD\n  A-->B",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/sessionId/);
  });

  it("rejects empty title", () => {
    const copilotHome = makeTmpDir();
    const result = publishMermaidArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "   ",
      source: "graph TD\n  A-->B",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/title/);
  });

  it("resolves a published mermaid artifact via resolveVisualArtifactForOwner", () => {
    const copilotHome = makeTmpDir();
    const source = "pie\n  \"A\" : 50\n  \"B\" : 50";

    const published = publishMermaidArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Pie Chart",
      source,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const resolved = resolveVisualArtifactForOwner(
      copilotHome,
      sessionVisualOwner(SESSION_ID),
      published.value.artifactId,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mimeType).toBe(MERMAID_MIME_TYPE);
    expect(resolved.value.displayName).toMatch(/\.mmd$/);
  });

  it("respects apiBasePath in generated URLs", () => {
    const copilotHome = makeTmpDir();
    const result = publishMermaidArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Flow",
      source: "graph TD\n  X-->Y",
      apiBasePath: "/staging/preview-abc/api",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toMatch(/^\/staging\/preview-abc\/api\//);
  });
});

describe("publishHtmlArtifact", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), "bridge-html-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("publishes an HTML artifact and returns structured artifact", () => {
    const copilotHome = makeTmpDir();
    const content = "<html><body><h1>Hello</h1></body></html>";

    const result = publishHtmlArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "My Page",
      content,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("html");
    expect(result.value.title).toBe("My Page");
    expect(result.value.mimeType).toBe(HTML_MIME_TYPE);
    expect(result.value.source).toBe(content);
    expect(result.value.size).toBeGreaterThan(0);
    expect(result.value.url).toMatch(/\/visuals\//);
    expect(result.value.downloadUrl).toMatch(/\/download/);
    expect(result.value.metaUrl).toMatch(/\/meta/);
    expect(isCanonicalArtifactId(result.value.artifactId)).toBe(true);
  });

  it("stores the HTML in a .html file and in metadata source", () => {
    const copilotHome = makeTmpDir();
    const content = "<html><body><p>Test</p></body></html>";

    const result = publishHtmlArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Test Page",
      content,
      caption: "A test page",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const visualsDir = join(copilotHome, "session-state", SESSION_ID, "files", "visuals");
    const fileContent = readFileSync(join(visualsDir, `${result.value.artifactId}.html`), "utf-8");
    expect(fileContent).toBe(content);

    const meta = JSON.parse(readFileSync(join(visualsDir, `${result.value.artifactId}.meta.json`), "utf-8"));
    expect(meta.kind).toBe("html");
    expect(meta.source).toBe(content);
    expect(meta.caption).toBe("A test page");
    expect(meta.mimeType).toBe(HTML_MIME_TYPE);
    expect(meta.ext).toBe("html");
  });

  it("rejects empty content", () => {
    const copilotHome = makeTmpDir();
    const result = publishHtmlArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Empty",
      content: "   ",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/empty/i);
  });

  it("rejects content exceeding the size limit", () => {
    const copilotHome = makeTmpDir();
    const bigContent = "A".repeat(MAX_HTML_SOURCE_BYTES + 1);
    const result = publishHtmlArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Huge",
      content: bigContent,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/size limit|MB/i);
  });

  it("rejects invalid sessionId", () => {
    const copilotHome = makeTmpDir();
    const result = publishHtmlArtifact({
      copilotHome,
      sessionId: "bad-id",
      title: "T",
      content: "<html></html>",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/sessionId/);
  });

  it("rejects empty title", () => {
    const copilotHome = makeTmpDir();
    const result = publishHtmlArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "   ",
      content: "<html></html>",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/title/);
  });

  it("resolves a published HTML artifact via resolveVisualArtifactForOwner", () => {
    const copilotHome = makeTmpDir();
    const content = "<html><body>Hello</body></html>";

    const published = publishHtmlArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Hello Page",
      content,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const resolved = resolveVisualArtifactForOwner(
      copilotHome,
      sessionVisualOwner(SESSION_ID),
      published.value.artifactId,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mimeType).toBe(HTML_MIME_TYPE);
    expect(resolved.value.displayName).toMatch(/\.html$/);
  });

  it("respects apiBasePath in generated URLs", () => {
    const copilotHome = makeTmpDir();
    const result = publishHtmlArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      title: "Page",
      content: "<html></html>",
      apiBasePath: "/staging/preview-abc/api",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toMatch(/^\/staging\/preview-abc\/api\//);
  });
});
