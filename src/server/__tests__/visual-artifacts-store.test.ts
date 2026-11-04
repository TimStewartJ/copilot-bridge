import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  HTML_MIME_TYPE,
  MAX_MERMAID_SOURCE_CHARS,
  loadVisualArtifactMetaForOwner,
  publishMermaidArtifact,
  publishVisualArtifact,
  resolveVisualArtifactForOwner,
  sessionVisualOwner,
} from "../visual-artifacts.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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
    expect(resolveVisualArtifactForOwner(copilotHome, owner, published.value.artifactId)).toMatchObject({
      ok: true, value: { mimeType: "image/png", displayName: "safe.png" },
    });

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

  it("opens HTML saved by the earlier visual publisher", () => {
    const copilotHome = makeTmpDir();
    const owner = sessionVisualOwner(SESSION_ID);
    const artifactId = "550e8400-e29b-41d4-a716-446655440000";
    const dir = join(copilotHome, "session-state", SESSION_ID, "files", "visuals");
    const source = "<button>Previous page</button>";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${artifactId}.html`), source);
    writeFileSync(join(dir, `${artifactId}.meta.json`), JSON.stringify({
      artifactId, kind: "html", title: "Earlier page", displayName: "page.html", mimeType: "text/html",
      size: Buffer.byteLength(source), ext: "html", source, createdAt: "2026-01-01T00:00:00Z",
    }));

    const resolved = resolveVisualArtifactForOwner(copilotHome, owner, artifactId);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value.mimeType).toBe(HTML_MIME_TYPE);
    expect(readFileSync(resolved.value.filePath, "utf-8")).toBe(source);
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

  it("returns the staged URLs and stored metadata of the same published image", () => {
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
      apiBasePath: "/staging/preview-abc/api",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    expect(published.value.size).toBeGreaterThan(0);
    expect(published.value.metaUrl).toContain(`/visuals/${published.value.artifactId}/meta`);
    expect(published.value.url).toMatch(/^\/staging\/preview-abc\/api\//);

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

});
