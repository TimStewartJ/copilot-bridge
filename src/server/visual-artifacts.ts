import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "./tool-results.js";
import { isCanonicalSessionId } from "./outbound-attachments.js";

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

export const MERMAID_MIME_TYPE = "text/vnd.mermaid";
export const MAX_MERMAID_SOURCE_CHARS = 100_000; // 100 KB

export const VEGA_LITE_MIME_TYPE = "application/vnd.vegalite+json";
export const MAX_VEGA_LITE_SOURCE_BYTES = 500_000; // 500 KB
export const MAX_VEGA_LITE_DEPTH = 20;

export const HTML_MIME_TYPE = "text/html";
export const MAX_HTML_SOURCE_BYTES = 1_048_576; // 1 MB

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VISUAL_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Phase 1: allow raster images only — SVG excluded for security */
export function isAllowedImageMime(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase().trim());
}

export function isCanonicalArtifactId(id: string): boolean {
  return ARTIFACT_ID_RE.test(id);
}

export function getVisualsDir(copilotHome: string, sessionId: string): string {
  return join(copilotHome, "session-state", sessionId, "files", "visuals");
}

function artifactFilePath(visualsDir: string, artifactId: string, ext: string): string {
  return join(visualsDir, `${artifactId}.${ext}`);
}

function artifactMetaPath(visualsDir: string, artifactId: string): string {
  return join(visualsDir, `${artifactId}.meta.json`);
}

export interface VisualArtifactMeta {
  artifactId: string;
  kind: "image" | "mermaid" | "vega-lite" | "html";
  title: string;
  displayName: string;
  mimeType: string;
  size: number;
  ext: string;
  caption?: string;
  altText?: string;
  /** Source text for mermaid/vega-lite/html artifacts */
  source?: string;
  createdAt: string;
}

export interface PublishVisualInput {
  copilotHome: string;
  sessionId: string;
  kind: "image";
  title: string;
  mimeType: string;
  /** Absolute filesystem path of an existing image file */
  sourcePath?: string;
  /** Base64-encoded image bytes */
  content?: string;
  displayName?: string;
  caption?: string;
  altText?: string;
  apiBasePath?: string;
}

export interface PublishMermaidInput {
  copilotHome: string;
  sessionId: string;
  title: string;
  /** Plain text Mermaid diagram source */
  source: string;
  displayName?: string;
  caption?: string;
  apiBasePath?: string;
}

export interface PublishedVisualArtifact {
  artifactId: string;
  kind: "image" | "mermaid" | "vega-lite" | "html";
  title: string;
  displayName: string;
  mimeType: string;
  size: number;
  /** URL for inline rendering (image) or source retrieval (mermaid/vega-lite/html) */
  url: string;
  downloadUrl: string;
  metaUrl: string;
  caption?: string;
  altText?: string;
  /** Mermaid/Vega-Lite/HTML source text (mermaid, vega-lite, and html kinds only) */
  source?: string;
}

export interface ResolvedVisualArtifact {
  filePath: string;
  displayName: string;
  mimeType: string;
}

function normalizeApiBase(apiBasePath: string | undefined): string {
  const trimmed = apiBasePath?.trim();
  if (!trimmed) return "/api";
  return (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).replace(/\/+$/, "");
}

function buildVisualUrl(apiBase: string, sessionId: string, artifactId: string, suffix: string): string {
  return `${apiBase}/sessions/${encodeURIComponent(sessionId)}/visuals/${encodeURIComponent(artifactId)}${suffix}`;
}

export function publishVisualArtifact(input: PublishVisualInput): Result<PublishedVisualArtifact> {
  if (!isCanonicalSessionId(input.sessionId)) {
    return err("sessionId is invalid");
  }

  const mimeType = input.mimeType?.toLowerCase().trim() ?? "";
  if (!isAllowedImageMime(mimeType)) {
    return err(
      `Unsupported mimeType: "${mimeType}". Allowed raster image types: ${[...ALLOWED_IMAGE_MIME_TYPES].join(", ")}`,
    );
  }

  const title = input.title?.trim() ?? "";
  if (!title) return err("title is required");

  const hasSourcePath = typeof input.sourcePath === "string" && input.sourcePath.trim().length > 0;
  const hasContent = typeof input.content === "string";
  if (hasSourcePath === hasContent) {
    return err("Provide exactly one of: path or content");
  }

  const ext = MIME_TO_EXT[mimeType] ?? "bin";
  const displayName = (typeof input.displayName === "string" && input.displayName.trim())
    ? input.displayName.trim()
    : hasSourcePath
      ? basename(input.sourcePath!.trim())
      : `image.${ext}`;

  const visualsDir = getVisualsDir(input.copilotHome, input.sessionId);

  try {
    mkdirSync(visualsDir, { recursive: true });

    const artifactId = randomUUID();
    const filePath = artifactFilePath(visualsDir, artifactId, ext);
    const metaPath = artifactMetaPath(visualsDir, artifactId);

    const root = resolve(visualsDir);
    if (!resolve(filePath).startsWith(root + sep)) {
      return err("Artifact path is unsafe");
    }

    if (hasSourcePath) {
      const src = input.sourcePath!.trim();
      if (!existsSync(src)) return err(`Image path not found: ${src}`);
      const srcStat = statSync(src);
      if (!srcStat.isFile()) return err(`Image path is not a file: ${src}`);
      if (srcStat.size > MAX_VISUAL_SIZE_BYTES) {
        return err(`Image file exceeds the ${MAX_VISUAL_SIZE_BYTES / (1024 * 1024)} MB size limit`);
      }
      copyFileSync(src, filePath);
    } else {
      const buf = Buffer.from(input.content!, "base64");
      if (buf.length > MAX_VISUAL_SIZE_BYTES) {
        return err(`Image content exceeds the ${MAX_VISUAL_SIZE_BYTES / (1024 * 1024)} MB size limit`);
      }
      writeFileSync(filePath, buf);
    }

    const { size } = statSync(filePath);

    const meta: VisualArtifactMeta = {
      artifactId,
      kind: "image",
      title,
      displayName,
      mimeType,
      size,
      ext,
      ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
      ...(input.altText?.trim() ? { altText: input.altText.trim() } : {}),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    const apiBase = normalizeApiBase(input.apiBasePath);
    return ok({
      artifactId,
      kind: "image",
      title,
      displayName,
      mimeType,
      size,
      url: buildVisualUrl(apiBase, input.sessionId, artifactId, ""),
      downloadUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/download"),
      metaUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/meta"),
      ...(meta.caption ? { caption: meta.caption } : {}),
      ...(meta.altText ? { altText: meta.altText } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to publish visual artifact: ${message}`);
  }
}

export function resolveVisualArtifact(
  copilotHome: string,
  sessionId: string,
  artifactId: string,
): Result<ResolvedVisualArtifact> {
  if (!isCanonicalSessionId(sessionId)) return err("sessionId is invalid");
  if (!isCanonicalArtifactId(artifactId)) return err("artifactId is invalid");

  const visualsDir = getVisualsDir(copilotHome, sessionId);
  const metaPath = artifactMetaPath(visualsDir, artifactId);

  if (!existsSync(metaPath)) return err("Visual artifact not found");

  let meta: VisualArtifactMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8")) as VisualArtifactMeta;
  } catch {
    return err("Visual artifact metadata is corrupted");
  }

  const filePath = artifactFilePath(visualsDir, artifactId, meta.ext);
  if (!existsSync(filePath)) return err("Visual artifact file not found");

  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    return err("Visual artifact not found");
  }

  const root = resolve(visualsDir) + sep;
  if (!realPath.startsWith(root)) return err("Visual artifact path is unsafe");

  return ok({ filePath: realPath, displayName: meta.displayName, mimeType: meta.mimeType });
}

export function loadVisualArtifactMeta(
  copilotHome: string,
  sessionId: string,
  artifactId: string,
): Result<VisualArtifactMeta> {
  if (!isCanonicalSessionId(sessionId)) return err("sessionId is invalid");
  if (!isCanonicalArtifactId(artifactId)) return err("artifactId is invalid");

  const visualsDir = getVisualsDir(copilotHome, sessionId);
  const metaPath = artifactMetaPath(visualsDir, artifactId);

  if (!existsSync(metaPath)) return err("Visual artifact not found");

  try {
    return ok(JSON.parse(readFileSync(metaPath, "utf-8")) as VisualArtifactMeta);
  } catch {
    return err("Visual artifact metadata is corrupted");
  }
}

export function publishMermaidArtifact(input: PublishMermaidInput): Result<PublishedVisualArtifact> {
  if (!isCanonicalSessionId(input.sessionId)) {
    return err("sessionId is invalid");
  }

  const title = input.title?.trim() ?? "";
  if (!title) return err("title is required");

  const source = typeof input.source === "string" ? input.source : "";
  if (!source.trim()) return err("Mermaid source must not be empty");
  if (source.length > MAX_MERMAID_SOURCE_CHARS) {
    return err(`Mermaid source exceeds the ${MAX_MERMAID_SOURCE_CHARS.toLocaleString()} character limit`);
  }

  const displayName = (typeof input.displayName === "string" && input.displayName.trim())
    ? input.displayName.trim()
    : `${title.replace(/[^a-z0-9_-]/gi, "_")}.mmd`;

  const visualsDir = getVisualsDir(input.copilotHome, input.sessionId);

  try {
    mkdirSync(visualsDir, { recursive: true });

    const artifactId = randomUUID();
    const filePath = artifactFilePath(visualsDir, artifactId, "mmd");
    const metaPath = artifactMetaPath(visualsDir, artifactId);

    const root = resolve(visualsDir);
    if (!resolve(filePath).startsWith(root + sep)) {
      return err("Artifact path is unsafe");
    }

    writeFileSync(filePath, source, "utf-8");
    const size = Buffer.byteLength(source, "utf-8");

    const meta: VisualArtifactMeta = {
      artifactId,
      kind: "mermaid",
      title,
      displayName,
      mimeType: MERMAID_MIME_TYPE,
      size,
      ext: "mmd",
      source,
      ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    const apiBase = normalizeApiBase(input.apiBasePath);
    return ok({
      artifactId,
      kind: "mermaid",
      title,
      displayName,
      mimeType: MERMAID_MIME_TYPE,
      size,
      url: buildVisualUrl(apiBase, input.sessionId, artifactId, ""),
      downloadUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/download"),
      metaUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/meta"),
      source,
      ...(meta.caption ? { caption: meta.caption } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to publish mermaid artifact: ${message}`);
  }
}

export interface PublishVegaLiteInput {
  copilotHome: string;
  sessionId: string;
  title: string;
  /** Vega-Lite spec as a JSON string or a pre-parsed object */
  spec: string | object;
  displayName?: string;
  caption?: string;
  apiBasePath?: string;
}

/** Returns the maximum nesting depth of a JSON value (1 = scalar / empty container). */
function jsonDepth(value: unknown, current = 0): number {
  if (current > MAX_VEGA_LITE_DEPTH) return current;
  if (Array.isArray(value)) {
    if (value.length === 0) return current + 1;
    return Math.max(...value.map((v) => jsonDepth(v, current + 1)));
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return current + 1;
    return Math.max(...keys.map((k) => jsonDepth((value as any)[k], current + 1)));
  }
  return current + 1;
}

/**
 * Returns an error string if the spec contains network-fetching `data.url` fields at any
 * level of nesting (top-level, composite views, lookup transforms, datasets, etc.).
 * Inline `data.values` is allowed.
 */
function checkVegaLiteNetworkData(spec: object): string | null {
  function check(node: unknown, path: string): string | null {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < (node as unknown[]).length; i++) {
        const r = check((node as unknown[])[i], `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    // Check data.url at this level
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      const data = obj.data as Record<string, unknown>;
      if (typeof data.url === "string") {
        return `Network data loading via data.url is not allowed (found at ${path}.data.url). Use data.values with inline data instead.`;
      }
    }
    // Check datasets object — each value may be a data source with a url
    if (obj.datasets && typeof obj.datasets === "object" && !Array.isArray(obj.datasets)) {
      const datasets = obj.datasets as Record<string, unknown>;
      for (const name of Object.keys(datasets)) {
        const ds = datasets[name];
        if (ds && typeof ds === "object" && !Array.isArray(ds) && typeof (ds as any).url === "string") {
          return `Network data loading via datasets["${name}"].url is not allowed. Use inline data.values instead.`;
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      const r = check(value, `${path}.${key}`);
      if (r) return r;
    }
    return null;
  }
  return check(spec, "spec");
}

export function publishVegaLiteArtifact(input: PublishVegaLiteInput): Result<PublishedVisualArtifact> {
  if (!isCanonicalSessionId(input.sessionId)) {
    return err("sessionId is invalid");
  }

  const title = input.title?.trim() ?? "";
  if (!title) return err("title is required");

  // Parse spec — accept string or object
  let specObj: object;
  if (typeof input.spec === "string") {
    const trimmed = input.spec.trim();
    if (!trimmed) return err("Vega-Lite spec must not be empty");
    if (Buffer.byteLength(trimmed, "utf-8") > MAX_VEGA_LITE_SOURCE_BYTES) {
      return err(
        `Vega-Lite spec exceeds the ${(MAX_VEGA_LITE_SOURCE_BYTES / 1000).toLocaleString()} KB size limit`,
      );
    }
    try {
      specObj = JSON.parse(trimmed);
    } catch {
      return err("Vega-Lite spec is not valid JSON");
    }
  } else if (input.spec !== null && typeof input.spec === "object") {
    specObj = input.spec;
  } else {
    return err("Vega-Lite spec must not be empty");
  }

  if (Array.isArray(specObj) || specObj === null) {
    return err("Vega-Lite spec must be a JSON object");
  }

  const source = JSON.stringify(specObj, null, 2);
  const sourceBytes = Buffer.byteLength(source, "utf-8");
  if (sourceBytes > MAX_VEGA_LITE_SOURCE_BYTES) {
    return err(
      `Vega-Lite spec exceeds the ${(MAX_VEGA_LITE_SOURCE_BYTES / 1000).toLocaleString()} KB size limit`,
    );
  }

  if (jsonDepth(specObj) > MAX_VEGA_LITE_DEPTH) {
    return err(`Vega-Lite spec exceeds the maximum nesting depth of ${MAX_VEGA_LITE_DEPTH}`);
  }

  const networkErr = checkVegaLiteNetworkData(specObj);
  if (networkErr) return err(networkErr);

  const displayName = (typeof input.displayName === "string" && input.displayName.trim())
    ? input.displayName.trim()
    : `${title.replace(/[^a-z0-9_-]/gi, "_")}.vl.json`;

  const visualsDir = getVisualsDir(input.copilotHome, input.sessionId);

  try {
    mkdirSync(visualsDir, { recursive: true });

    const artifactId = randomUUID();
    const filePath = artifactFilePath(visualsDir, artifactId, "vl.json");
    const metaPath = artifactMetaPath(visualsDir, artifactId);

    const root = resolve(visualsDir);
    if (!resolve(filePath).startsWith(root + sep)) {
      return err("Artifact path is unsafe");
    }

    writeFileSync(filePath, source, "utf-8");
    const size = Buffer.byteLength(source, "utf-8");

    const meta: VisualArtifactMeta = {
      artifactId,
      kind: "vega-lite",
      title,
      displayName,
      mimeType: VEGA_LITE_MIME_TYPE,
      size,
      ext: "vl.json",
      source,
      ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    const apiBase = normalizeApiBase(input.apiBasePath);
    return ok({
      artifactId,
      kind: "vega-lite",
      title,
      displayName,
      mimeType: VEGA_LITE_MIME_TYPE,
      size,
      url: buildVisualUrl(apiBase, input.sessionId, artifactId, ""),
      downloadUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/download"),
      metaUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/meta"),
      source,
      ...(meta.caption ? { caption: meta.caption } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to publish Vega-Lite artifact: ${message}`);
  }
}

export interface PublishHtmlInput {
  copilotHome: string;
  sessionId: string;
  title: string;
  /** Plain text HTML content */
  content: string;
  displayName?: string;
  caption?: string;
  apiBasePath?: string;
}

export function publishHtmlArtifact(input: PublishHtmlInput): Result<PublishedVisualArtifact> {
  if (!isCanonicalSessionId(input.sessionId)) {
    return err("sessionId is invalid");
  }

  const title = input.title?.trim() ?? "";
  if (!title) return err("title is required");

  const content = typeof input.content === "string" ? input.content : "";
  if (!content.trim()) return err("HTML content must not be empty");

  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > MAX_HTML_SOURCE_BYTES) {
    return err(`HTML content exceeds the ${(MAX_HTML_SOURCE_BYTES / (1024 * 1024)).toLocaleString()} MB size limit`);
  }

  const displayName = (typeof input.displayName === "string" && input.displayName.trim())
    ? input.displayName.trim()
    : `${title.replace(/[^a-z0-9_-]/gi, "_")}.html`;

  const visualsDir = getVisualsDir(input.copilotHome, input.sessionId);

  try {
    mkdirSync(visualsDir, { recursive: true });

    const artifactId = randomUUID();
    const filePath = artifactFilePath(visualsDir, artifactId, "html");
    const metaPath = artifactMetaPath(visualsDir, artifactId);

    const root = resolve(visualsDir);
    if (!resolve(filePath).startsWith(root + sep)) {
      return err("Artifact path is unsafe");
    }

    writeFileSync(filePath, content, "utf-8");
    const size = Buffer.byteLength(content, "utf-8");

    const meta: VisualArtifactMeta = {
      artifactId,
      kind: "html",
      title,
      displayName,
      mimeType: HTML_MIME_TYPE,
      size,
      ext: "html",
      source: content,
      ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    const apiBase = normalizeApiBase(input.apiBasePath);
    return ok({
      artifactId,
      kind: "html",
      title,
      displayName,
      mimeType: HTML_MIME_TYPE,
      size,
      url: buildVisualUrl(apiBase, input.sessionId, artifactId, ""),
      downloadUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/download"),
      metaUrl: buildVisualUrl(apiBase, input.sessionId, artifactId, "/meta"),
      source: content,
      ...(meta.caption ? { caption: meta.caption } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to publish HTML artifact: ${message}`);
  }
}
