import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isPathAtOrUnder } from "./path-utils.js";

export type StartWorkAttachment =
  | { type: "blob"; data: string; mimeType: string; displayName?: string }
  | { type: "uploaded"; displayName: string; mimeType: string };

export type RoutedSdkAttachment = { type: string; [k: string]: any };

export interface AttachmentRoutingDeps {
  copilotHome?: string;
  logger?: Pick<Console, "log" | "warn">;
}

/** Generate a unique filename in dir, appending (1), (2) etc. if needed */
export function deduplicateFilename(dir: string, name: string): string {
  // Sanitize: use basename to strip directory components, then remove any remaining traversal
  const safe = basename(name).replace(/\.\./g, "_") || "attachment";
  if (!existsSync(join(dir, safe))) return safe;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let i = 1;
  while (existsSync(join(dir, `${stem} (${i})${ext}`))) i++;
  return `${stem} (${i})${ext}`;
}

/** A file a message carried, as saved in the session's files/ folder. */
export interface SavedSessionAttachment {
  type: "uploaded";
  displayName: string;
  mimeType: string;
  size?: number;
}

export interface PersistedSessionAttachments {
  /** What the SDK is given. */
  routed: RoutedSdkAttachment[] | undefined;
  /** What was kept on disk, by the names it was saved under, so the message can be shown or sent again. */
  saved: SavedSessionAttachment[];
}

/**
 * Save blob attachments to the session's files/ directory and convert
 * non-image attachments to SDK `file` type (path-based) so the agent
 * can access them with its tools. Images stay as `blob` for inline viewing.
 */
export function persistAndRouteAttachments(
  sessionId: string,
  attachments?: StartWorkAttachment[],
  deps: AttachmentRoutingDeps = {},
): RoutedSdkAttachment[] | undefined {
  return persistSessionAttachments(sessionId, attachments, deps).routed;
}

export function persistSessionAttachments(
  sessionId: string,
  attachments?: StartWorkAttachment[],
  deps: AttachmentRoutingDeps = {},
): PersistedSessionAttachments {
  if (!attachments?.length) return { routed: undefined, saved: [] };

  const logger = deps.logger ?? console;
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const filesDir = join(copilotHome, "session-state", sessionId, "files");
  mkdirSync(filesDir, { recursive: true });

  const result: RoutedSdkAttachment[] = [];
  const saved: SavedSessionAttachment[] = [];
  for (const att of attachments) {
    if (att.type === "uploaded") {
      // File already on disk from multipart upload
      const safeName = basename(att.displayName).replace(/\.\./g, "_") || "attachment";
      const filePath = join(filesDir, safeName);
      if (!isPathAtOrUnder(filesDir, filePath)) {
        logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Skipping uploaded attachment with unsafe name: ${att.displayName}`);
        continue;
      }
      if (!existsSync(filePath)) {
        logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Uploaded file not found: ${safeName}`);
        continue;
      }
      if (att.mimeType.startsWith("image/")) {
        // Images: read and convert to blob so the model sees them visually
        const bytes = readFileSync(filePath);
        result.push({ type: "blob", data: bytes.toString("base64"), mimeType: att.mimeType, displayName: safeName });
        saved.push({ type: "uploaded", displayName: safeName, mimeType: att.mimeType, size: bytes.length });
      } else {
        result.push({ type: "file", path: filePath, displayName: safeName });
        saved.push({ type: "uploaded", displayName: safeName, mimeType: att.mimeType });
      }
      logger.log(`[sdk] [${sessionId.slice(0, 8)}] Resolved uploaded attachment: ${safeName} (${att.mimeType})`);
    } else {
      // Legacy blob path: decode base64 and save to disk
      const safeName = deduplicateFilename(filesDir, att.displayName ?? "attachment");
      const filePath = join(filesDir, safeName);
      if (!isPathAtOrUnder(filesDir, filePath)) {
        logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Skipping attachment with unsafe name: ${att.displayName}`);
        continue;
      }
      const bytes = Buffer.from(att.data, "base64");
      writeFileSync(filePath, bytes);
      saved.push({ type: "uploaded", displayName: safeName, mimeType: att.mimeType, size: bytes.length });

      if (att.mimeType.startsWith("image/")) {
        // Named as saved: history shows a sent image from the session's copy by this name.
        result.push({ ...att, displayName: safeName });
      } else {
        result.push({ type: "file", path: filePath, displayName: safeName });
      }
      logger.log(`[sdk] [${sessionId.slice(0, 8)}] Saved attachment: ${safeName} (${att.mimeType})`);
    }
  }
  return { routed: result, saved };
}
