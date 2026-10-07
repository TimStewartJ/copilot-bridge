import { randomUUID } from "node:crypto";

export const DISPOSABLE_TITLE_SESSION_ID_PREFIX = "b17e1000";

const TITLE_SYSTEM_PROMPT = `Generate a short title for a chat session based on the user's message.

Rules:
- Use 2-6 words.
- Use title case.
- Focus on the task, not conversational wording.
- Do not include quotes.
- Do not include leading or trailing punctuation.
- Reply with only a JSON object of the form {"title": "..."}.`;

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

const TRAILING_CLOSING_TAGS = /(?:\s*<[/|][a-z][\w-]*\|?>)+\s*$/i;

/**
 * Removes closing tags and `<|…|>` markers left at the end of a title, as in
 * "Fix Login Redirect</session-title>". Titles stored while the helper was asked for tags have them.
 */
export function stripTrailingClosingTags(title: string): string {
  return title.replace(TRAILING_CLOSING_TAGS, "");
}

const JSON_TITLE = /\{\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g;
/** A reply that set out to be the JSON, whether or not a title can be read from it. */
const JSON_ATTEMPT = /^\s*(?:```|\{)|"title"/;

/**
 * The title in the last `{"title": "..."}` of the reply. Models put code fences or stray text
 * around the object, and one that drafts aloud gives its answer last.
 */
function titleFromJson(rawOutput: string): string | undefined {
  const literal = [...rawOutput.matchAll(JSON_TITLE)].at(-1)?.[1];
  if (literal === undefined) return undefined;
  try {
    return JSON.parse(literal) as string;
  } catch {
    return undefined;
  }
}

/**
 * How the helper model framed its reply: as the JSON it was asked for, as JSON that cannot be
 * read, or as plain text. The model is picked by price and so changes without a release; this is
 * where that shows.
 */
export function describeTitleReply(rawOutput: unknown): "json" | "unreadable" | "bare" | "none" {
  if (typeof rawOutput !== "string") return "none";
  if (titleFromJson(rawOutput) !== undefined) return "json";
  return JSON_ATTEMPT.test(rawOutput) ? "unreadable" : "bare";
}

export function extractGeneratedSessionTitle(rawOutput: unknown): string | undefined {
  if (typeof rawOutput !== "string") return undefined;
  const jsonTitle = titleFromJson(rawOutput);
  // JSON that cannot be read is not shown as a title. A reply with no JSON at all is the title.
  if (jsonTitle === undefined && JSON_ATTEMPT.test(rawOutput)) return undefined;
  const title = stripTrailingClosingTags(jsonTitle ?? rawOutput).trim().replace(/^["']+|["']+$/g, "").trim();
  if (title.length < 3 || title.length > 100) return undefined;
  return title;
}
