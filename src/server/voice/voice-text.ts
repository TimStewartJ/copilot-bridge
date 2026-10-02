// The Bridge's hands-free vocabulary: the name it answers to and the short commands it handles
// itself. The speech-shaping rules (what to say from a streamed reply, how to chunk it, how to
// read an interruption) are the in-tree package src/packages/voice-agent-text.
import {
  createBargeInClassifier,
  createWakePhraseMatcher,
  normalizeUtterance,
  type WakeMatch,
} from "../../packages/voice-agent-text/src/index.js";

export {
  countWords,
  isFillerUtterance,
  ON_SCREEN_PHRASE,
  SpokenTextFilter,
  takeSpeechChunks,
  toSpeakableText,
  type BargeInVerdict,
  type SpeechChunkResult,
  type WakeMatch,
} from "../../packages/voice-agent-text/src/index.js";

/** "Bridge" and the ways the recognizer mishears it. */
const wakePhrase = createWakePhraseMatcher({ names: ["bridge", "bridget", "brij", "bridges"] });

/** Detects "hey Bridge …" at the start of an utterance while hands-free is asleep. */
export function matchWakePhrase(text: string): WakeMatch | undefined {
  return wakePhrase.match(text);
}

/** Removes a leading "hey Bridge" from an utterance spoken while already awake. */
export function stripLeadingWakePhrase(text: string): string {
  return wakePhrase.stripLeading(text);
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

/**
 * Decides whether speech heard while the assistant is talking is a real interruption
 * or a reaction ("yeah", "really?", laughter) that should not cut it off. "Hey Bridge" always is.
 */
export const classifyBargeIn = createBargeInClassifier({ interruptPhrases: ["hey bridge"] });
