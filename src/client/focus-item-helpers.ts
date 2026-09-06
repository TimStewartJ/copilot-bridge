import type { FocusObject } from "./api";

export const DEFAULT_FOCUS_ACTION_LABEL = "Start session";
export const DEFAULT_FOCUS_CHAT_LABEL = "Discuss item";
export const DEFAULT_FOCUS_CHAT_MESSAGE = "Let's discuss this focus item.";

const FEED_CHAT_BODY_MAX_CHARS = 8_000;
const FEED_CHAT_DETAIL_MAX_CHARS = 1_000;

export function resolveFocusActionTaskId(card: Pick<FocusObject, "taskId" | "launchPrompt">): string | null {
  if (!card.launchPrompt) return null;
  return Object.prototype.hasOwnProperty.call(card.launchPrompt, "taskId")
    ? card.launchPrompt.taskId ?? null
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

export function buildFocusItemChatContext(card: FocusObject): string {
  const category = card.objectType === "event" ? card.category : card.objectType;
  const lines = [
    "# Focus item context",
    `- Title: ${card.title}`,
    `- Type: ${card.objectType}`,
    ...(card.objectType === "event" ? [`- Category: ${category}`] : []),
    `- Status: ${card.status}`,
    `- Lifecycle: ${card.lifecycle} (acknowledgement and handoff are not resolution)`,
    `- Episode: ${card.activationId}`,
    `- Priority: ${card.priority}`,
  ];

  if (card.pinned) lines.push("- Pinned: yes");
  addDetail(lines, "Source", typeof card.metadata?.source === "string" ? card.metadata.source : null);
  addDetail(lines, "Created", card.createdAt);
  addDetail(lines, "Updated", card.updatedAt);
  addDetail(lines, "Related task ID", card.taskId);
  addDetail(lines, "Related session ID", card.sessionId);
  addDetail(lines, "URL", card.url);
  addDetail(lines, "Source family", card.details.sourceFamily);
  addDetail(lines, "Producer", card.details.producer);
  addDetail(lines, "Observed", card.details.observedAt);
  addDetail(lines, "Valid until", card.details.validUntil);
  addDetail(lines, "Intervene by", card.details.interventionBy);
  addDetail(lines, "Impact", card.details.impact);
  addDetail(lines, "Consequence of waiting", card.details.consequenceOfDelay);
  addDetail(lines, "Recommendation", card.details.recommendation);
  addDetail(lines, "No response / fallback", card.details.fallback);
  addDetail(lines, "Outcome", card.details.outcome);
  addDetail(lines, "Resolution reason", card.details.resolutionReason);
  addDetail(lines, "Authority grant ID (scope must be inspected)", card.details.authorizationGrantId);
  if (card.details.alternatives.length) {
    lines.push("", "## Alternatives");
    for (const alternative of card.details.alternatives) addDetail(lines, "Option", alternative);
  }
  if (card.details.evidence.length) {
    lines.push("", "## Evidence");
    for (const evidence of card.details.evidence) {
      addDetail(lines, "Observation", typeof evidence === "string" ? evidence : evidence.summary);
      if (typeof evidence !== "string") {
        addDetail(lines, "Evidence URL", evidence.url);
        addDetail(lines, "Evidence observed at", evidence.observedAt);
      }
    }
  }
  if (card.linkedActions.length) {
    lines.push("", "## Linked Actions (completion does not resolve the source)");
    for (const link of card.linkedActions) {
      addDetail(lines, link.action.done ? "Completed Action" : "Open Action", `${link.action.text} [${link.actionId}]`);
    }
  }

  if (card.links.length > 0) {
    lines.push("", "## Links");
    for (const link of card.links) {
      lines.push(`- ${link.label}: ${link.url}`);
    }
  }

  if (card.launchPrompt) {
    lines.push("", "## Launch prompt");
    addDetail(lines, "Label", card.launchPrompt.label ?? DEFAULT_FOCUS_ACTION_LABEL);
    addDetail(lines, "Prompt", card.launchPrompt.prompt);
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

export function buildFocusItemChatPrompt(context: string, message: string): string {
  const normalizedMessage = compactText(message) || DEFAULT_FOCUS_CHAT_MESSAGE;
  return [
    "Use the focus item context below when responding.",
    "",
    context,
    "",
    "# My message",
    normalizedMessage,
  ].join("\n");
}
