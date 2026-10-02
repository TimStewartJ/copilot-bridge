// What to say out loud from text a language model wrote to be read.

const CODE_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((?:[^)\s]+)\)/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Said in place of content that was shown instead of spoken. */
export const ON_SCREEN_PHRASE = "I've put that on screen.";

export interface SpeakableTextOptions {
  /** Said in place of a fenced code block. Default: ON_SCREEN_PHRASE. Pass "" to drop code silently. */
  codeBlockPhrase?: string;
  /** Said in place of a bare URL. Default: "a link". */
  urlPhrase?: string;
  /** Said in place of a UUID. Default: "that one". */
  uuidPhrase?: string;
}

/** Converts model output (which should already be plain speech) into text that TTS reads naturally. */
export function toSpeakableText(text: string, options: SpeakableTextOptions = {}): string {
  const codeBlockPhrase = options.codeBlockPhrase ?? ON_SCREEN_PHRASE;
  const urlPhrase = options.urlPhrase ?? "a link";
  const uuidPhrase = options.uuidPhrase ?? "that one";
  return text
    .replace(CODE_BLOCK_RE, () => ` ${codeBlockPhrase} `)
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(BARE_URL_RE, () => urlPhrase)
    .replace(UUID_RE, () => uuidPhrase)
    .replace(INLINE_CODE_RE, "$1")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(EMOJI_RE, "")
    // Before the markup strip below, which would otherwise take the ">" and leave a dash.
    .replace(/\s*(?:-+>|\u2192)\s*/g, " to ")
    .replace(/[*_~>|#]+/g, "")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,;:]+/, "")
    .trim();
}
