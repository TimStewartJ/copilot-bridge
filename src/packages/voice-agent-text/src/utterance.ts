// How to read a short utterance from a speech recognizer: noise, the wake phrase, a listener's
// reaction, or a real interruption. The word lists are English.

/** Lowercases an utterance and strips punctuation, so it can be compared as plain words. */
export function normalizeUtterance(text: string): string {
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternation(words: readonly string[]): string {
  return `(?:${words.map(escapeRegExp).join("|")})`;
}

function cleanWords(words: readonly string[]): string[] {
  return words.map((word) => word.trim()).filter(Boolean);
}

/** A letter, digit or underscore in any script. `\b` only knows ASCII, so word edges are spelled out with this. */
const WORD_CHARACTER = "[\\p{L}\\p{N}_]";
/**
 * The start of a word, for patterns that are only tested. It consumes the character before the
 * word instead of looking behind, which Safari could not do before 16.4.
 */
const WORD_START = "(?:^|[^\\p{L}\\p{N}_])";

const DEFAULT_WAKE_GREETINGS = ["hey", "hi", "hello", "okay", "ok", "yo", "oi", "hay"];

export interface WakePhraseOptions {
  /** What the assistant answers to, including the ways a recognizer mishears it ("bridge", "bridget", "brij"). */
  names: readonly string[];
  /** Words that may come before the name. Default: hey, hi, hello, okay, ok, yo, oi, hay. */
  greetings?: readonly string[];
}

export interface WakeMatch {
  /** What was said after the wake phrase, which may be empty. */
  remainder: string;
}

export interface WakePhraseMatcher {
  /** Detects the wake phrase at the start of an utterance: "hey <name> ..." or just "<name> ...". */
  match(text: string): WakeMatch | undefined;
  /**
   * Removes a leading "hey <name>" from an utterance spoken while the assistant is already
   * listening. A bare name is kept, because it may be the subject of the sentence.
   */
  stripLeading(text: string): string;
}

export function createWakePhraseMatcher(options: WakePhraseOptions): WakePhraseMatcher {
  const names = cleanWords(options.names);
  if (names.length === 0) throw new Error("A wake phrase needs at least one name.");
  const greetings = cleanWords(options.greetings ?? DEFAULT_WAKE_GREETINGS);
  const name = alternation(names);
  const greeting = greetings.length > 0 ? `${alternation(greetings)}[\\s,.!]+` : undefined;
  const afterName = `(?!${WORD_CHARACTER})[\\s,.!?:;-]*([\\s\\S]*)$`;
  const anyStart = new RegExp(`^\\s*${greeting ? `(?:${greeting})?` : ""}${name}${afterName}`, "iu");
  const greetedStart = greeting ? new RegExp(`^\\s*${greeting}${name}${afterName}`, "iu") : undefined;

  return {
    match(text) {
      const match = text.match(anyStart);
      return match ? { remainder: (match[1] ?? "").trim() } : undefined;
    },
    stripLeading(text) {
      const match = greetedStart ? text.match(greetedStart) : null;
      return match ? (match[1] ?? "").trim() : text.trim();
    },
  };
}

const BACKCHANNEL_WORDS = [
  "yeah", "yes", "yep", "yup", "ya", "ok", "okay", "uh-huh", "uh", "huh", "mhm", "mm", "hmm", "hm", "um", "right",
  "sure", "cool", "nice", "wow", "oh", "ah", "ha", "haha", "hahaha", "lol", "really", "true", "totally", "exactly",
  "got", "it", "i", "see", "makes", "sense", "so", "funny", "that's", "thats", "amazing", "great", "awesome",
  "interesting", "neat", "sweet", "good", "fine", "wild", "whoa", "woah", "damn", "dang", "gosh", "omg", "my",
  "god", "fair", "perfect", "love", "cute", "weird", "who", "indeed", "ooh", "aw", "aww", "hah", "heh",
];

/** Regular-expression sources, matched against normalized text. */
const INTERRUPT_PATTERNS = [
  "stop", "wait", "hold on", "hang on", "actually", "no no", "cancel", "never ?mind", "shut up", "be quiet", "pause",
  "excuse me", "listen", "instead", "change of plans", "forget (?:it|that)",
];

const LONG_SPEECH_MS = 2_500;

/**
 * "stop": a real interruption, so stop speaking and listen. "ignore": a reaction or noise, so
 * keep speaking. "undecided": too little heard so far, so keep speaking and ask again.
 */
export type BargeInVerdict = "stop" | "ignore" | "undecided";

export interface BargeInSpeech {
  /** How long the user has been speaking, in milliseconds. */
  speechMs: number;
  /** True when `text` is the recognizer's final transcript of the utterance, false for a partial one. */
  final: boolean;
}

export interface BargeInClassifierOptions {
  /** Phrases that always interrupt, on top of the built-in ones: typically the wake phrase ("hey computer"). */
  interruptPhrases?: readonly string[];
  /** Words treated as reactions, on top of the built-in ones. */
  backchannelWords?: readonly string[];
  /** Speech at least this long interrupts whatever was said. Default 2500 ms. */
  longSpeechMs?: number;
}

export type BargeInClassifier = (text: string, speech: BargeInSpeech) => BargeInVerdict;

/**
 * Builds a classifier that decides whether speech heard while the assistant is talking is a real
 * interruption or a reaction ("yeah", "really?", laughter) that should not cut it off.
 */
export function createBargeInClassifier(options: BargeInClassifierOptions = {}): BargeInClassifier {
  const extraPhrases = cleanWords((options.interruptPhrases ?? []).map(normalizeUtterance)).map(escapeRegExp);
  const interrupt = new RegExp(
    `${WORD_START}(?:${[...INTERRUPT_PATTERNS, ...extraPhrases].join("|")})(?!${WORD_CHARACTER})`,
    "u",
  );
  const backchannel = new Set([...BACKCHANNEL_WORDS, ...cleanWords((options.backchannelWords ?? []).map(normalizeUtterance))]);
  const longSpeechMs = options.longSpeechMs ?? LONG_SPEECH_MS;

  return (text, speech) => {
    const normalized = normalizeUtterance(text);
    if (speech.speechMs >= longSpeechMs && normalized) return "stop";
    if (!normalized || isFillerUtterance(text)) {
      return speech.final ? "ignore" : "undecided";
    }
    if (interrupt.test(normalized)) return "stop";
    const words = normalized.split(" ");
    const backchannelOnly = words.every((word) => backchannel.has(word));
    if (backchannelOnly) return speech.final ? "ignore" : "undecided";
    if (words.length >= 3) return "stop";
    if (!speech.final) return "undecided";
    if (words.length === 1 && !/\?\s*$/.test(text.trim())) return "ignore";
    return "stop";
  };
}

/** The classifier with its built-in English word lists. */
export const classifyBargeIn: BargeInClassifier = /*#__PURE__*/ createBargeInClassifier();
