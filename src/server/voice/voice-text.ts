// Text helpers for hands-free voice: what to speak, how to chunk it for
// low-latency synthesis, and how to interpret short utterances.

const CODE_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((?:[^)\s]+)\)/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Converts model output (which should already be plain speech) into text that TTS reads naturally. */
export function toSpeakableText(text: string): string {
  return text
    .replace(CODE_BLOCK_RE, " I've put that on screen. ")
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(BARE_URL_RE, "a link")
    .replace(UUID_RE, "that one")
    .replace(INLINE_CODE_RE, "$1")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(EMOJI_RE, "")
    .replace(/[*_~>|#]+/g, "")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/\s*(?:->|\u2192)\s*/g, " to ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,;:]+/, "")
    .trim();
}

export interface SpeechChunkResult {
  chunks: string[];
  rest: string;
}

type SpokenLineKind = "prose" | "structure" | "fence";

const DIVIDER_LINE_RE = /^\s*([-*_])\1{2,}\s*$/;

/**
 * Decides what a line is from as little of its start as possible, so prose can be spoken the
 * moment it begins streaming. Undefined means "not enough characters yet".
 */
function classifyLineStart(line: string, context: { inFence: boolean; afterStructure: boolean }): SpokenLineKind | undefined {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;
  const fence = /^(`{3,}|~{3,})/.test(trimmed);
  if (context.inFence) {
    if (fence) return "fence";
    return trimmed.length < 3 && /^(`*|~*)$/.test(trimmed) ? undefined : "structure";
  }
  if (!trimmed) return undefined;
  // Indented text under a list item or quote belongs to it.
  if (context.afterStructure && indent >= 2) return "structure";
  const first = trimmed[0]!;
  if (first === "`" || first === "~") {
    if (fence) return "fence";
    return trimmed.length < 3 && /^(`+|~+)$/.test(trimmed) ? undefined : "prose";
  }
  if (first === "|" || first === ">") return "structure";
  if (first === "#") {
    if (/^#{1,6}$/.test(trimmed)) return undefined;
    return /^#{1,6}\s/.test(trimmed) ? "structure" : "prose";
  }
  if (first === "-" || first === "*" || first === "+" || first === "_") {
    if (trimmed.length === 1) return undefined;
    if (first !== "_" && /\s/.test(trimmed[1]!)) return "structure";
    // A run of the same marker may still become a divider ("---") or emphasis ("**bold**").
    if (/^([-*_])\1*\s*$/.test(trimmed)) return undefined;
    return "prose";
  }
  if (first >= "0" && first <= "9") {
    if (/^\d{1,9}[.)]?$/.test(trimmed)) return undefined;
    return /^\d{1,9}[.)]\s/.test(trimmed) ? "structure" : "prose";
  }
  return "prose";
}

/**
 * Picks the speakable part out of a streamed hands-free reply: sentences are spoken, structure
 * is shown. Lists, tables, headings, quotes and code go to the chat without being read aloud,
 * and so does everything after a divider line ("---"). This is deliberately structural rather
 * than a convention the model has to follow, because fast models often don't.
 */
export class SpokenTextFilter {
  private line = "";
  private kind: SpokenLineKind | undefined;
  private inFence = false;
  private afterStructure = false;
  private silenced = false;
  private withheldValue = false;

  /** True once anything in this message was shown instead of spoken. */
  get withheld(): boolean {
    return this.withheldValue;
  }

  push(delta: string): string {
    let spoken = "";
    for (const char of delta) spoken += this.accept(char);
    return spoken;
  }

  /** The message ended: settle a last line that never got its newline. */
  flush(): string {
    const spoken = this.kind === undefined ? this.settleUndecided(false) : "";
    this.line = "";
    this.kind = undefined;
    return spoken;
  }

  reset(): void {
    this.line = "";
    this.kind = undefined;
    this.inFence = false;
    this.afterStructure = false;
    this.silenced = false;
    this.withheldValue = false;
  }

  private accept(char: string): string {
    if (this.silenced) {
      if (char.trim()) this.withheldValue = true;
      return "";
    }
    if (char === "\n") return this.endLine();
    if (this.kind === "prose") return char;
    if (this.kind !== undefined) return "";
    this.line += char;
    const kind = classifyLineStart(this.line, { inFence: this.inFence, afterStructure: this.afterStructure });
    if (!kind) return "";
    this.kind = kind;
    const started = this.line;
    this.line = "";
    if (kind === "prose") return started;
    this.withheldValue = true;
    if (kind === "fence") this.inFence = !this.inFence;
    return "";
  }

  private endLine(): string {
    const kind = this.kind;
    const spoken = kind === undefined ? this.settleUndecided(true) : kind === "prose" ? "\n" : "";
    if (kind === "prose") this.afterStructure = false;
    else if (kind !== undefined) this.afterStructure = true;
    this.line = "";
    this.kind = undefined;
    return spoken;
  }

  /** A line that ended before it could be classified: blank, a divider, or a stray marker. */
  private settleUndecided(endedWithNewline: boolean): string {
    const line = this.line;
    if (this.inFence) {
      if (line.trim()) this.withheldValue = true;
      return "";
    }
    if (!line.trim()) {
      this.afterStructure = false;
      return endedWithNewline ? "\n" : "";
    }
    if (DIVIDER_LINE_RE.test(line)) {
      this.silenced = true;
      return endedWithNewline ? "\n" : "";
    }
    // A bare number is still something to say ("42"); a stray "-" or "#" is not.
    if (/^\s*\d+[.)]?\s*$/.test(line)) return endedWithNewline ? `${line}\n` : line;
    this.withheldValue = true;
    this.afterStructure = true;
    return "";
  }
}

/** Spoken when a reply put everything on screen and left nothing to say. */
export const ON_SCREEN_PHRASE = "I've put that on screen.";

const SENTENCE_END_RE = /[.!?\u2026]+["')\]]*(?=\s)|\n+/g;
const MIN_SENTENCE_CHARS = 12;
const FIRST_CLAUSE_MIN = 15;
const FIRST_CLAUSE_MAX = 90;
const MAX_CHUNK_CHARS = 240;

function splitAtClause(text: string, minChars: number, maxChars: number): [string, string] | undefined {
  const re = /[,;:\u2014\u2013]\s+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const end = match.index + 1;
    if (end < minChars) continue;
    if (end > maxChars) break;
    const head = text.slice(0, end).trim();
    const tail = text.slice(match.index + match[0].length).trim();
    return tail.length >= 20 ? [head, tail] : undefined;
  }
  return undefined;
}

function splitLongChunk(chunk: string): string[] {
  if (chunk.length <= MAX_CHUNK_CHARS) return [chunk];
  const split = splitAtClause(chunk, 60, MAX_CHUNK_CHARS);
  if (!split) return [chunk];
  return [split[0], ...splitLongChunk(split[1])];
}

/**
 * Pulls speakable chunks out of streamed assistant text. The first chunk of a reply is
 * split at an early clause boundary so audio can start before the full sentence arrives.
 */
export function takeSpeechChunks(
  buffer: string,
  options: { firstChunk: boolean; flush?: boolean },
): SpeechChunkResult {
  const sentences: string[] = [];
  let start = 0;
  const re = new RegExp(SENTENCE_END_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer))) {
    const end = match.index + match[0].length;
    const candidate = buffer.slice(start, end).trim();
    if (candidate.length >= MIN_SENTENCE_CHARS || match[0].includes("\n")) {
      if (candidate) sentences.push(candidate);
      start = end;
    }
  }
  let rest = buffer.slice(start);
  if (options.flush && rest.trim()) {
    sentences.push(rest.trim());
    rest = "";
  }

  if (options.firstChunk) {
    if (sentences.length > 0 && sentences[0]!.length > FIRST_CLAUSE_MAX) {
      const split = splitAtClause(sentences[0]!, FIRST_CLAUSE_MIN, FIRST_CLAUSE_MAX);
      if (split) sentences.splice(0, 1, split[0], split[1]);
    } else if (sentences.length === 0 && rest.length >= 60) {
      const clause = rest.match(/^([\s\S]{15,90}?[,;:\u2014\u2013])\s+/);
      if (clause) {
        sentences.push(clause[1]!.trim());
        rest = rest.slice(clause[0].length);
      }
    }
  }

  return { chunks: sentences.flatMap(splitLongChunk), rest };
}

function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}'\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

export function countWords(text: string): number {
  const normalized = normalizeUtterance(text);
  return normalized ? normalized.split(" ").length : 0;
}

const FILLER_WORD_RE = /^(?:u+h*m+|u+h+|h+m+|m+h*m*|a+h+|e+r+m*|huh|mhm|uh-?huh|oh+|ooh+)$/;

/** True for utterances that carry no request: silence, breath noise, "um", "huh". */
export function isFillerUtterance(text: string): boolean {
  const normalized = normalizeUtterance(text);
  if (!normalized) return true;
  if (normalized.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return true;
  return normalized.split(" ").every((word) => FILLER_WORD_RE.test(word));
}

const WAKE_WORDS = "(?:bridge|bridget|brij|bridges)";
const WAKE_PREFIX = "(?:hey|hi|hello|okay|ok|yo|oi|hay)";
const WAKE_RE = new RegExp(`^\\s*(?:${WAKE_PREFIX}[\\s,.!]+)?${WAKE_WORDS}\\b[\\s,.!?:;-]*([\\s\\S]*)$`, "i");
const PREFIXED_WAKE_RE = new RegExp(`^\\s*${WAKE_PREFIX}[\\s,.!]+${WAKE_WORDS}\\b[\\s,.!?:;-]*([\\s\\S]*)$`, "i");

export interface WakeMatch {
  remainder: string;
}

/** Detects "hey Bridge …" at the start of an utterance while hands-free is asleep. */
export function matchWakePhrase(text: string): WakeMatch | undefined {
  const match = text.match(WAKE_RE);
  if (!match) return undefined;
  return { remainder: (match[1] ?? "").trim() };
}

/** Removes a leading "hey Bridge" from an utterance spoken while already awake. */
export function stripLeadingWakePhrase(text: string): string {
  const match = text.match(PREFIXED_WAKE_RE);
  return match ? (match[1] ?? "").trim() : text.trim();
}

export type LocalVoiceCommand = "sleep" | "stop" | "end";

const POLITE_PREFIX = "(?:(?:okay|ok|alright|all right|thanks|thank you|cool|great)\\s+)*";
const SLEEP_RE = new RegExp(`^${POLITE_PREFIX}(?:go to sleep|sleep mode|stop listening|goodbye|good bye|bye(?: bye)?|bye for now|that's all(?: for now)?|thats all(?: for now)?|good night|goodnight|go quiet|pause listening)$`);
const STOP_RE = new RegExp(`^${POLITE_PREFIX}(?:stop|stop talking|cancel|cancel that|never mind|nevermind|shush|hush|quiet|be quiet|shut up|enough|pause)$`);
const END_RE = /^(?:end|exit|close|leave|turn off|stop) (?:voice mode|hands[- ]free(?: mode)?)$/;

/** Short commands handled locally without a model round trip. */
export function detectLocalCommand(text: string): LocalVoiceCommand | undefined {
  const normalized = normalizeUtterance(text);
  if (!normalized) return undefined;
  if (END_RE.test(normalized)) return "end";
  if (SLEEP_RE.test(normalized)) return "sleep";
  if (STOP_RE.test(normalized)) return "stop";
  return undefined;
}

const BACKCHANNEL_WORDS = new Set([
  "yeah", "yes", "yep", "yup", "ya", "ok", "okay", "uh-huh", "uh", "huh", "mhm", "mm", "hmm", "hm", "um", "right",
  "sure", "cool", "nice", "wow", "oh", "ah", "ha", "haha", "hahaha", "lol", "really", "true", "totally", "exactly",
  "got", "it", "i", "see", "makes", "sense", "so", "funny", "that's", "thats", "amazing", "great", "awesome",
  "interesting", "neat", "sweet", "good", "fine", "wild", "whoa", "woah", "damn", "dang", "gosh", "omg", "my",
  "god", "fair", "perfect", "love", "cute", "weird", "who", "indeed", "ooh", "aw", "aww", "hah", "heh",
]);

const INTERRUPT_RE = /\b(?:stop|wait|hold on|hang on|actually|no no|cancel|never ?mind|shut up|be quiet|pause|excuse me|listen|hey bridge|instead|change of plans|forget (?:it|that))\b/;

export type BargeInVerdict = "stop" | "ignore" | "undecided";

/**
 * Decides whether speech heard while the assistant is talking is a real interruption
 * or a reaction ("yeah", "really?", laughter) that should not cut it off.
 */
export function classifyBargeIn(text: string, options: { speechMs: number; final: boolean }): BargeInVerdict {
  const normalized = normalizeUtterance(text);
  if (options.speechMs >= 2_500 && normalized) return "stop";
  if (!normalized || isFillerUtterance(text)) {
    return options.final ? "ignore" : "undecided";
  }
  if (INTERRUPT_RE.test(normalized)) return "stop";
  const words = normalized.split(" ");
  const backchannelOnly = words.every((word) => BACKCHANNEL_WORDS.has(word));
  if (backchannelOnly) return options.final ? "ignore" : "undecided";
  if (words.length >= 3) return "stop";
  if (!options.final) return "undecided";
  if (words.length === 1 && !/\?\s*$/.test(text.trim())) return "ignore";
  return "stop";
}
