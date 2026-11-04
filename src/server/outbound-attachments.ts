import { constants, copyFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { err, ok, type Result } from "./tool-results.js";
import { isPathAtOrUnder } from "./path-utils.js";

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  log: "text/plain",
  m4a: "audio/mp4",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
};

const INLINE_RENDERABLE_MIME_TYPES = new Set([
  "image/avif",
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

function numberedFilename(name: string, index: number): string {
  if (index === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${index})${name.slice(dot)}`
    : `${name} (${index})`;
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

export function getSessionFilesDir(copilotHome: string, sessionId: string): string {
  return join(copilotHome, "session-state", sessionId, "files");
}

/** Where the runtime's image tool saves what it generates or edits. */
export function getSessionGeneratedImagesDir(copilotHome: string, sessionId: string): string {
  return join(copilotHome, "session-state", sessionId, "images");
}

/** One file directly inside `dir`, resolved through links, or an error the routes map to 403/404. */
function resolveDirectChildFile(dir: string, fileName: string): Result<ResolvedOutboundAttachment> {
  if (!fileName || basename(fileName) !== fileName || fileName.includes("..")) return err("fileName is invalid");
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) return err("File not found");

  let realPath: string;
  let realDir: string;
  try {
    realPath = realpathSync(filePath);
    realDir = realpathSync(dir);
  } catch {
    return err("File not found");
  }
  if (!isPathAtOrUnder(realDir, realPath) || dirname(realPath) !== realDir) return err("File path is unsafe");

  try {
    if (!statSync(realPath).isFile()) return err("File not found");
  } catch {
    return err("File not found");
  }
  const displayName = basename(realPath);
  const mimeType = inferOutboundAttachmentMimeType(displayName);
  return ok({ filePath: realPath, displayName, mimeType, inline: isInlineRenderableAttachment(mimeType) });
}

/**
 * A file the user attached to a prompt, kept in the session's files/ folder. The CLI records sent
 * images without their bytes, so chat history shows them from here. Only direct children of the
 * folder resolve; subfolders such as outgoing/ and visuals/ have routes of their own.
 */
export function resolveSessionUploadedFile(copilotHome: string, sessionId: string, fileName: string): Result<ResolvedOutboundAttachment> {
  if (!isCanonicalSessionId(sessionId)) return err("sessionId is invalid");
  return resolveDirectChildFile(getSessionFilesDir(copilotHome, sessionId), fileName);
}

/** An image the runtime's image tool saved for this session. Only raster images resolve. */
export function resolveSessionGeneratedImage(copilotHome: string, sessionId: string, fileName: string): Result<ResolvedOutboundAttachment> {
  if (!isCanonicalSessionId(sessionId)) return err("sessionId is invalid");
  if (!isInlineRenderableAttachment(inferOutboundAttachmentMimeType(fileName))) return err("fileName is invalid");
  return resolveDirectChildFile(getSessionGeneratedImagesDir(copilotHome, sessionId), fileName);
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

  const name = sanitizeAttachmentName(requestedName);
  if (hasContent && inferOutboundAttachmentMimeType(name) === MIME_TYPES_BY_EXTENSION.html) {
    return err("Save the HTML to a file and send its path instead of content.");
  }

  const outgoingDir = getOutboundAttachmentDir(input.copilotHome, input.sessionId);
  try {
    if (hasSourcePath) {
      const sourceStat = statSync(sourcePath, { throwIfNoEntry: false });
      if (!sourceStat) return err(`Attachment path not found: ${sourcePath}`);
      if (!sourceStat.isFile()) return err(`Attachment path is not a file: ${sourcePath}`);
    }
    mkdirSync(outgoingDir, { recursive: true });

    for (let index = 0; ; index++) {
      const storedName = numberedFilename(name, index);
      const filePath = join(outgoingDir, storedName);
      if (!isPathAtOrUnder(outgoingDir, filePath)) return err("Attachment filename is unsafe");
      try {
        if (hasSourcePath) copyFileSync(sourcePath, filePath, constants.COPYFILE_EXCL);
        else writeFileSync(filePath, input.content ?? "", { encoding: "utf-8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const mimeType = inferOutboundAttachmentMimeType(storedName);
      return ok({
        attachmentId: storedName,
        displayName: storedName,
        mimeType,
        size: statSync(filePath).size,
        filePath,
        inline: isInlineRenderableAttachment(mimeType),
      });
    }
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
  let realOutgoingDir: string;
  try {
    realPath = realpathSync(filePath);
    realOutgoingDir = realpathSync(outgoingDir);
  } catch {
    return err("Attachment not found");
  }

  if (!isPathAtOrUnder(realOutgoingDir, realPath)) return err("Attachment path is unsafe");

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
