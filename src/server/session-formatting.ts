import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import type { Task } from "./task-store.js";

export function formatLinkedPullRequest(pr: Task["pullRequests"][number]): string {
  return `${pr.repoName || pr.repoId} #${pr.prId}`;
}

const SESSION_FORMATTING_REPO_ROOT = resolveBridgeControlRoot(
  join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);

export function resolvePublishableAttachmentSourcePath(pathValue: string, repoRoot = SESSION_FORMATTING_REPO_ROOT): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return isAbsolute(pathValue) ? pathValue : resolve(repoRoot, pathValue);
}

export function escapeAttachmentMarkdownText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

export function encodeAttachmentUrlSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildSessionAttachmentUrlPath(apiBasePath: string | undefined, sessionId: string, attachmentId: string): string {
  const trimmed = apiBasePath?.trim();
  const normalizedBase = !trimmed
    ? "/api"
    : (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).replace(/\/+$/, "");
  return `${normalizedBase}/sessions/${encodeAttachmentUrlSegment(sessionId)}/attachments/${encodeAttachmentUrlSegment(attachmentId)}`;
}

export function renderPublishedAttachment(
  apiBasePath: string,
  sessionId: string,
  attachment: {
    attachmentId: string;
    displayName: string;
    inline: boolean;
  },
): {
  urlPath: string;
  linkMarkdown: string;
  imageMarkdown?: string;
  recommendedMarkdown: string;
} {
  const urlPath = buildSessionAttachmentUrlPath(apiBasePath, sessionId, attachment.attachmentId);
  const escapedDisplayName = escapeAttachmentMarkdownText(attachment.displayName);
  const linkMarkdown = `[${escapedDisplayName}](${urlPath})`;
  const imageMarkdown = attachment.inline ? `![${escapedDisplayName}](${urlPath})` : undefined;
  return {
    urlPath,
    linkMarkdown,
    imageMarkdown,
    recommendedMarkdown: imageMarkdown ?? linkMarkdown,
  };
}

export function parseWorkspaceCwd(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("cwd:")) continue;
    const cwd = line.slice(5).trim();
    if (cwd) return cwd;
  }
  return undefined;
}

export function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function escapePromptText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeUnicodeLineSeparators(text: string): string {
  return text
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function escapePromptLiteral(text: string): string {
  return escapePromptText(
    escapeUnicodeLineSeparators(
      text
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " "),
    ),
  );
}

const SIMPLE_PROMPT_TAG_RE = /^[\p{L}\p{N}._:/-]+$/u;

export function formatPromptTag(tag: string): string {
  return SIMPLE_PROMPT_TAG_RE.test(tag)
    ? escapePromptText(tag)
    : escapePromptText(escapeUnicodeLineSeparators(JSON.stringify(tag)));
}

function briefLabel(value: string, limit: number): string {
  const text = normalizeInlineText(value);
  return escapePromptText(text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);
}

export function formatRelatedDocManifestEntry(doc: {
  title: string;
  path: string;
  description?: string;
  matchedTags: string[];
}): string | undefined {
  const path = escapePromptLiteral(doc.path);
  // A clipped path isn't a usable docs_read pointer. The page is still discoverable with docs_search.
  if (path.length > 240) return undefined;
  const title = briefLabel(doc.title, 64);
  let line = `- ${title} (${path})`;
  const description = doc.description ? briefLabel(doc.description, 96) : "";
  if (description) line += ` — ${description}`;
  const tags = doc.matchedTags.slice(0, 2).filter((tag) => tag && tag.length <= 40).map(formatPromptTag);
  if (tags.length > 0) {
    const suffix = description && !/[.!?…]$/.test(description) ? "." : "";
    line += `${suffix} [matched: ${tags.join(", ")}]`;
  }
  return line;
}
