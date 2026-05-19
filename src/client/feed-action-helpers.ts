import type { FeedCard as FeedCardData } from "./api";

export const DEFAULT_FEED_ACTION_LABEL = "Start session";
export const DEFAULT_FEED_CHAT_LABEL = "Chat with card";
export const DEFAULT_FEED_CHAT_MESSAGE = "Let's discuss this feed card.";

const FEED_CHAT_BODY_MAX_CHARS = 8_000;
const FEED_CHAT_DETAIL_MAX_CHARS = 1_000;

export function resolveFeedActionTaskId(card: Pick<FeedCardData, "taskId" | "action">): string | null {
  if (!card.action) return null;
  return Object.prototype.hasOwnProperty.call(card.action, "taskId")
    ? card.action.taskId ?? null
    : card.taskId ?? null;
}

function compactText(value: string): string {
  return value.trim().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[Truncated ${value.length - maxChars} additional characters]`;
}

function addDetail(lines: string[], label: string, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (!normalized) return;
  lines.push(`- ${label}: ${truncateText(normalized, FEED_CHAT_DETAIL_MAX_CHARS)}`);
}

export function buildFeedCardChatContext(card: FeedCardData): string {
  const lines = [
    "# Feed card context",
    `- Title: ${card.title}`,
    `- Kind: ${card.kind}`,
    `- Status: ${card.status}`,
    `- Priority: ${card.priority}`,
  ];

  if (card.pinned) lines.push("- Pinned: yes");
  addDetail(lines, "Source", typeof card.metadata?.source === "string" ? card.metadata.source : null);
  addDetail(lines, "Created", card.createdAt);
  addDetail(lines, "Updated", card.updatedAt);
  addDetail(lines, "Related task ID", card.taskId);
  addDetail(lines, "Related session ID", card.sessionId);
  addDetail(lines, "URL", card.url);

  if (card.links.length > 0) {
    lines.push("", "## Links");
    for (const link of card.links) {
      lines.push(`- ${link.label}: ${link.url}`);
    }
  }

  if (card.action) {
    lines.push("", "## Action CTA");
    addDetail(lines, "Label", card.action.label ?? DEFAULT_FEED_ACTION_LABEL);
    addDetail(lines, "Prompt", card.action.prompt);
  }

  if (card.visual) {
    lines.push("", "## Visual");
    lines.push(`- Type: ${card.visual.kind}`);
    addDetail(lines, "Title", card.visual.title);
    addDetail(lines, "File", card.visual.displayName);
    addDetail(lines, "MIME type", card.visual.mimeType);
    addDetail(lines, "Caption", card.visual.caption);
    addDetail(lines, "Alt text", card.visual.altText);
  }

  lines.push("", "## Body");
  const body = compactText(card.body ?? "");
  lines.push(body ? truncateText(body, FEED_CHAT_BODY_MAX_CHARS) : "_No body was provided._");

  return lines.join("\n");
}

export function buildFeedCardChatPrompt(context: string, message: string): string {
  const normalizedMessage = compactText(message) || DEFAULT_FEED_CHAT_MESSAGE;
  return [
    "Use the feed card context below when responding.",
    "",
    context,
    "",
    "# My message",
    normalizedMessage,
  ].join("\n");
}
