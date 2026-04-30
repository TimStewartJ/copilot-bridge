import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_TITLE_WORD_RE, looksLikePromptEchoTitle, normalizeSessionTitle } from "./session-title-utils.js";

const SESSION_FORMATTING_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  const linkMarkdown = `[${escapeAttachmentMarkdownText(`Download ${attachment.displayName}`)}](${urlPath})`;
  const imageMarkdown = attachment.inline ? `![${escapedDisplayName}](${urlPath})` : undefined;
  return {
    urlPath,
    linkMarkdown,
    imageMarkdown,
    recommendedMarkdown: imageMarkdown ?? linkMarkdown,
  };
}

export function deriveFallbackSessionTitle(sourceText: string): string | undefined {
  const normalized = normalizeSessionTitle(sourceText);
  if (!normalized) return undefined;

  const trimmedLeadIn = normalized
    .replace(/^(please\s+)?(can|could|would|will)\s+you\s+/i, "")
    .replace(/^let'?s\s+/i, "")
    .replace(/^help\s+me\s+/i, "")
    .replace(/^i\s+(need|want)\s+to\s+/i, "")
    .replace(/^we\s+need\s+to\s+/i, "")
    .trim();

  const words = (trimmedLeadIn || normalized).match(SESSION_TITLE_WORD_RE) ?? [];
  if (words.length === 0) return undefined;

  const fallbackTitle = normalizeSessionTitle(words.slice(0, 6).join(" "));
  if (!fallbackTitle || fallbackTitle.length > 80 || looksLikePromptEchoTitle(fallbackTitle)) {
    return undefined;
  }

  return fallbackTitle[0]?.toUpperCase() + fallbackTitle.slice(1);
}

export function parseWorkspaceSummary(content: string): string | undefined {
  let summary: string | undefined;
  let inSummary = false;
  const summaryLines: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (inSummary) {
      if (line.startsWith("  ")) {
        summaryLines.push(line.slice(2));
        continue;
      }
      if (line.trim() === "") {
        summaryLines.push("");
        continue;
      }
      inSummary = false;
    }
    if (line.startsWith("summary: |-")) {
      inSummary = true;
    } else if (line.startsWith("summary:")) {
      summary = line.slice(9).trim();
    }
  }

  return summary ?? (summaryLines.length > 0 ? summaryLines.join("\n") : undefined);
}

export function parseWorkspaceCwd(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("cwd:")) continue;
    const cwd = line.slice(5).trim();
    if (cwd) return cwd;
  }
  return undefined;
}

export function looksLikeExistingSessionTitle(summary: string): boolean {
  const normalized = normalizeSessionTitle(summary);
  if (!normalized) return false;
  const wordCount = normalized.match(SESSION_TITLE_WORD_RE)?.length ?? 0;
  return normalized.length <= 80 && wordCount <= 8;
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

export function formatPromptTagList(tags: string[]): string {
  return tags.map(formatPromptTag).join(", ");
}

export function formatRelatedDocManifestEntry(doc: {
  title: string;
  path: string;
  description?: string;
  matchedTags: string[];
}): string {
  const title = escapePromptText(normalizeInlineText(doc.title));
  const path = escapePromptLiteral(doc.path);
  const description = doc.description ? escapePromptText(normalizeInlineText(doc.description)) : "";
  const matchedTags = doc.matchedTags.filter(Boolean);

  let line = `- ${title} (${path})`;
  if (description) line += ` — ${description}`;
  if (matchedTags.length > 0) {
    const suffix = description && !/[.!?]$/.test(description) ? "." : "";
    line += `${suffix} [matched: ${formatPromptTagList(matchedTags)}]`;
  }
  return line;
}

export function isPromptEchoSummary(summary: string, firstUserPrompt?: string): boolean {
  const normalizedSummary = normalizeSessionTitle(summary);
  const normalizedPrompt = normalizeSessionTitle(firstUserPrompt);
  if (!normalizedSummary || !normalizedPrompt) return false;
  if (normalizedSummary === normalizedPrompt) return true;
  if (!normalizedPrompt.startsWith(normalizedSummary)) return false;

  const summaryWords = normalizedSummary.match(SESSION_TITLE_WORD_RE)?.length ?? 0;
  const promptWords = normalizedPrompt.match(SESSION_TITLE_WORD_RE)?.length ?? 0;
  return normalizedPrompt.length - normalizedSummary.length >= 20
    || promptWords - summaryWords >= 3;
}
