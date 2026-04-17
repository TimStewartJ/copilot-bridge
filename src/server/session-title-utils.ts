const SESSION_TITLE_PROMPT_ECHO_PATTERNS = [
  /^(?:generate|create|write)(?: a)? concise(?: \d+-\d+ word)? title(?: for (?:this conversation|the current session))?\.?$/i,
  /^reply with only the title text(?: [—-] no quotes, no punctuation unless it'?s part of a name)?\.?$/i,
  /^(?:if this session does not already have a concise title, after your first substantive response )?call `?session_rename`? with a concise \d+-\d+ word title for the current session(?:\.? do this silently without mentioning it to the user\.?)?$/i,
] as const;

export const SESSION_TITLE_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'/-]*/gu;

export function normalizeSessionTitle(rawTitle: unknown): string {
  return typeof rawTitle === "string"
    ? rawTitle.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ")
    : "";
}

export function looksLikePromptEchoTitle(title: string): boolean {
  const normalized = normalizeSessionTitle(title);
  return normalized
    ? SESSION_TITLE_PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(normalized))
    : false;
}
