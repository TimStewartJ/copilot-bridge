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

/** Strips closing tags and `<|…|>` markers that end older stored titles ("Fix Login</title>"). */
export function stripTrailingClosingTags(title: string): string {
  return title.replace(TRAILING_CLOSING_TAGS, "");
}

const JSON_TITLE = /\{\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g;
/** A reply that set out to be the JSON, whether or not a title can be read from it. */
const JSON_ATTEMPT = /^\s*(?:```|\{)|"title"/;

/** Uses the last `{"title": ...}`: models wrap it in fences or text, and drafts end with it. */
function titleFromJson(rawOutput: string): string | undefined {
  const literal = [...rawOutput.matchAll(JSON_TITLE)].at(-1)?.[1];
  if (literal === undefined) return undefined;
  try {
    return JSON.parse(literal) as string;
  } catch {
    return undefined;
  }
}

/** The helper model is chosen by price and changes without a release; this tracks reply shape. */
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
