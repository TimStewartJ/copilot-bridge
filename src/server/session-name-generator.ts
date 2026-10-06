import { randomUUID } from "node:crypto";

export const DISPOSABLE_TITLE_SESSION_ID_PREFIX = "b17e1000";

const TITLE_SYSTEM_PROMPT = `Generate a short title for a chat session based on the user's message.

Rules:
- Use 2-6 words.
- Use title case.
- Focus on the task, not conversational wording.
- Do not include quotes.
- Do not include leading or trailing punctuation.
- Return only the title inside <session-title></session-title>.`;

export function createDisposableTitleSessionId(): string {
  const uuid = randomUUID();
  return `${DISPOSABLE_TITLE_SESSION_ID_PREFIX}${uuid.slice(DISPOSABLE_TITLE_SESSION_ID_PREFIX.length)}`;
}

export function isDisposableTitleSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${DISPOSABLE_TITLE_SESSION_ID_PREFIX}-`);
}

export function buildSessionTitleSystemPrompt(): string {
  return TITLE_SYSTEM_PROMPT;
}

export function buildSessionTitleUserPrompt(userMessages: string[]): string {
  const content = userMessages
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(-20)
    .join("\n\n");
  return `Generate a session title for this message:

<user_message>
${content}
</user_message>`;
}

const LEADING_OPENING_TAGS = /^(?:\s*<[a-z][\w-]*>)+\s*/i;
const TRAILING_CLOSING_TAGS = /(?:\s*<\/[a-z][\w-]*>)+\s*$/i;

/** Removes closing tags left at the end of a title, as in "Fix Login Redirect</session-title>". */
export function stripTrailingClosingTags(title: string): string {
  return title.replace(TRAILING_CLOSING_TAGS, "");
}

export function extractGeneratedSessionTitle(rawOutput: unknown): string | undefined {
  if (typeof rawOutput !== "string") return undefined;
  const tagged = rawOutput.match(/<session-title>\s*([\s\S]*?)\s*<\/session-title>/i);
  // Some models answer with only one of the two tags, or close with a different tag.
  const rawTitle = stripTrailingClosingTags((tagged?.[1] ?? rawOutput).replace(LEADING_OPENING_TAGS, "")).trim();
  const title = rawTitle.replace(/^["']+|["']+$/g, "").trim();
  if (title.length < 3 || title.length > 100) return undefined;
  return title;
}
