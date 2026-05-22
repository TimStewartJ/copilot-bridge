import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { err, ok, type Result } from "./tool-results.js";

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  bmp: "image/bmp",
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
};

const INLINE_RENDERABLE_MIME_TYPES = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SESSION_ID_RE = /^[a-f0-9-]{36}$/i;

export interface PublishOutboundAttachmentInput {
  copilotHome: string;
  sessionId: string;
  sourcePath?: string;
  content?: string;
  displayName?: string;
}

export interface PublishedOutboundAttachment {
  attachmentId: string;
  displayName: string;
  mimeType: string;
  size: number;
  filePath: string;
  inline: boolean;
}

export interface ResolvedOutboundAttachment {
  filePath: string;
  displayName: string;
  mimeType: string;
  inline: boolean;
}

export function isCanonicalSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId);
}

function sanitizeAttachmentName(name: string): string {
  const safe = basename(name).replace(/\.\./g, "_").trim();
  if (!safe || safe === "." || safe === "..") return "attachment";
  return safe;
}

function deduplicateFilename(dir: string, name: string): string {
  const safe = sanitizeAttachmentName(name);
  if (!existsSync(join(dir, safe))) return safe;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let i = 1;
  while (existsSync(join(dir, `${stem} (${i})${ext}`))) i++;
  return `${stem} (${i})${ext}`;
}

export function inferOutboundAttachmentMimeType(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return "application/octet-stream";
  const ext = fileName.slice(dot + 1).toLowerCase();
  return MIME_TYPES_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export function isInlineRenderableAttachment(mimeType: string): boolean {
  return INLINE_RENDERABLE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function getOutboundAttachmentDir(copilotHome: string, sessionId: string): string {
  return join(copilotHome, "session-state", sessionId, "files", "outgoing");
}

export function publishOutboundAttachment(input: PublishOutboundAttachmentInput): Result<PublishedOutboundAttachment> {
  if (!isCanonicalSessionId(input.sessionId)) {
    return err("sessionId is invalid");
  }

  const sourcePath = typeof input.sourcePath === "string" ? input.sourcePath.trim() : "";
  const hasSourcePath = sourcePath.length > 0;
  const hasContent = typeof input.content === "string";
  if (hasSourcePath === hasContent) {
    return err("Provide exactly one of: path or content");
  }

  const requestedName = (typeof input.displayName === "string" && input.displayName.trim())
    ? input.displayName.trim()
    : hasSourcePath
      ? basename(sourcePath)
      : "";
  if (!requestedName) {
    return err("displayName is required when content is provided");
  }

  const outgoingDir = getOutboundAttachmentDir(input.copilotHome, input.sessionId);
  try {
    mkdirSync(outgoingDir, { recursive: true });

    const storedName = deduplicateFilename(outgoingDir, requestedName);
    const filePath = join(outgoingDir, storedName);
    const root = resolve(outgoingDir);
    if (!resolve(filePath).startsWith(root + sep)) {
      return err("Attachment filename is unsafe");
    }

    if (hasSourcePath) {
      if (!existsSync(sourcePath)) return err(`Attachment path not found: ${sourcePath}`);
      const sourceStat = statSync(sourcePath);
      if (!sourceStat.isFile()) return err(`Attachment path is not a file: ${sourcePath}`);
      copyFileSync(sourcePath, filePath);
    } else {
      writeFileSync(filePath, input.content ?? "", "utf-8");
    }

    const { size } = statSync(filePath);
    const mimeType = inferOutboundAttachmentMimeType(storedName);
    const attachmentId = storedName;

    return ok({
      attachmentId,
      displayName: storedName,
      mimeType,
      size,
      filePath,
      inline: isInlineRenderableAttachment(mimeType),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to publish attachment: ${message}`);
  }
}

export function resolveOutboundAttachment(copilotHome: string, sessionId: string, attachmentId: string): Result<ResolvedOutboundAttachment> {
  if (!isCanonicalSessionId(sessionId)) {
    return err("sessionId is invalid");
  }
  const outgoingDir = getOutboundAttachmentDir(copilotHome, sessionId);
  const filePath = join(outgoingDir, attachmentId);
  if (!existsSync(filePath)) return err("Attachment not found");

  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    return err("Attachment not found");
  }

  const root = resolve(outgoingDir) + sep;
  if (!realPath.startsWith(root)) return err("Attachment path is unsafe");

  let stat;
  try {
    stat = statSync(realPath);
  } catch {
    return err("Attachment not found");
  }
  if (!stat.isFile()) return err("Attachment not found");

  const displayName = basename(realPath);
  const mimeType = inferOutboundAttachmentMimeType(displayName);
  return ok({
    filePath: realPath,
    displayName,
    mimeType,
    inline: isInlineRenderableAttachment(mimeType),
  });
}
