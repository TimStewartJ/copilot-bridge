import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
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

  it("rejects unsupported mime types, ambiguous sources, and invalid sessionIds", () => {
    const copilotHome = makeTmpDir();
    const base = { copilotHome, sessionId: SESSION_ID, kind: "image" as const, title: "T" };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...base, title: "SVG", mimeType: "image/svg+xml", content: "" }, /Unsupported/],
      [{ ...base, mimeType: "image/png", sourcePath: "/some/path", content: "data" }, /exactly one/],
      [{ ...base, sessionId: "bad-id", mimeType: "image/png", content: "" }, /sessionId/],
    ];
    for (const [input, expected] of cases) {
      const result = publishVisualArtifact(input as any);
      expect(result.ok).toBe(false);
      expect((result as any).error).toMatch(expected);
    }
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

  it("accepts a valid artifact and rejects a resolved path outside the visuals directory", () => {
    const copilotHome = makeTmpDir();
    const srcDir = makeTmpDir();
    const srcPath = join(srcDir, "safe.png");
    writeFileSync(srcPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const published = publishVisualArtifact({
      copilotHome,
      sessionId: SESSION_ID,
      kind: "image",
      title: "Safe",
      mimeType: "image/png",
      sourcePath: srcPath,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const owner = sessionVisualOwner(SESSION_ID);
    expect(resolveVisualArtifactForOwner(copilotHome, owner, published.value.artifactId).ok).toBe(true);

    const visualsDir = join(copilotHome, "session-state", SESSION_ID, "files", "visuals");
    const metaPath = join(visualsDir, `${published.value.artifactId}.meta.json`);
    const metadata = JSON.parse(readFileSync(metaPath, "utf-8"));
    mkdirSync(join(visualsDir, `${published.value.artifactId}.escape`));
    writeFileSync(join(visualsDir, "..", "outside.png"), Buffer.from([0x89, 0x50]));
    metadata.ext = `escape${sep}..${sep}..${sep}outside.png`;
    writeFileSync(metaPath, JSON.stringify(metadata), "utf-8");

    const unsafe = resolveVisualArtifactForOwner(copilotHome, owner, published.value.artifactId);

    expect(unsafe.ok).toBe(false);
    expect(unsafe.ok ? "" : unsafe.error).toContain("path is unsafe");
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

  it("rejects empty sources, oversized sources, invalid sessionIds, and empty titles", () => {
    const copilotHome = makeTmpDir();
    const source = "graph TD\n  A-->B";
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ copilotHome, sessionId: SESSION_ID, title: "Empty", source: "   " }, /empty/],
      [{ copilotHome, sessionId: SESSION_ID, title: "Huge", source: "A".repeat(MAX_MERMAID_SOURCE_CHARS + 1) }, /character limit/],
      [{ copilotHome, sessionId: "bad-id", title: "T", source }, /sessionId/],
      [{ copilotHome, sessionId: SESSION_ID, title: "   ", source }, /title/],
    ];
    for (const [input, expected] of cases) {
      const result = publishMermaidArtifact(input as any);
      expect(result.ok).toBe(false);
      expect((result as any).error).toMatch(expected);
    }
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

  it("rejects empty content, oversized content, invalid sessionIds, and empty titles", () => {
    const copilotHome = makeTmpDir();
    const content = "<html></html>";
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ copilotHome, sessionId: SESSION_ID, title: "Empty", content: "   " }, /empty/i],
      [{ copilotHome, sessionId: SESSION_ID, title: "Huge", content: "A".repeat(MAX_HTML_SOURCE_BYTES + 1) }, /size limit|MB/i],
      [{ copilotHome, sessionId: "bad-id", title: "T", content }, /sessionId/],
      [{ copilotHome, sessionId: SESSION_ID, title: "   ", content }, /title/],
    ];
    for (const [input, expected] of cases) {
      const result = publishHtmlArtifact(input as any);
      expect(result.ok).toBe(false);
      expect((result as any).error).toMatch(expected);
    }
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

});
