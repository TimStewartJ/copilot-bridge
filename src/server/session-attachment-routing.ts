import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

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
  if (!attachments?.length) return undefined;

  const logger = deps.logger ?? console;
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const filesDir = join(copilotHome, "session-state", sessionId, "files");
  mkdirSync(filesDir, { recursive: true });

  const result: RoutedSdkAttachment[] = [];
  for (const att of attachments) {
    if (att.type === "uploaded") {
      // File already on disk from multipart upload
      const safeName = basename(att.displayName).replace(/\.\./g, "_") || "attachment";
      const filePath = join(filesDir, safeName);
      if (!resolve(filePath).startsWith(resolve(filesDir) + sep)) {
        logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Skipping uploaded attachment with unsafe name: ${att.displayName}`);
        continue;
      }
      if (!existsSync(filePath)) {
        logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Uploaded file not found: ${safeName}`);
        continue;
      }
      if (att.mimeType.startsWith("image/")) {
        // Images: read and convert to blob so the model sees them visually
        const data = readFileSync(filePath).toString("base64");
        result.push({ type: "blob", data, mimeType: att.mimeType, displayName: safeName });
      } else {
        result.push({ type: "file", path: filePath, displayName: safeName });
      }
      logger.log(`[sdk] [${sessionId.slice(0, 8)}] Resolved uploaded attachment: ${safeName} (${att.mimeType})`);
    } else {
      // Legacy blob path: decode base64 and save to disk
      const safeName = deduplicateFilename(filesDir, att.displayName ?? "attachment");
      const filePath = join(filesDir, safeName);
      if (!resolve(filePath).startsWith(resolve(filesDir) + sep)) {
        logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Skipping attachment with unsafe name: ${att.displayName}`);
        continue;
      }
      writeFileSync(filePath, Buffer.from(att.data, "base64"));

      if (att.mimeType.startsWith("image/")) {
        result.push(att);
      } else {
        result.push({ type: "file", path: filePath, displayName: safeName });
      }
      logger.log(`[sdk] [${sessionId.slice(0, 8)}] Saved attachment: ${safeName} (${att.mimeType})`);
    }
  }
  return result;
}
