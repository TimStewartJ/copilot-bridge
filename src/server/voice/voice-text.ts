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

/**
 * Commands the hands-free layer handles itself, without a model round trip. `stop` only stops
 * speech; `cancel` stops the chat's running work. `progress`, `repeat` and `full` are about the
 * chat's work and replies and are never sent to the chat.
 */
export type LocalVoiceCommand = "sleep" | "stop" | "end" | "cancel" | "progress" | "repeat" | "full";

const POLITE_PREFIX = "(?:(?:okay|ok|alright|all right|thanks|thank you|cool|great|hey|so|and|um|uh)\\s+)*";
const SLEEP_RE = new RegExp(`^${POLITE_PREFIX}(?:go to sleep|sleep mode|stop listening|goodbye|good bye|bye(?: bye)?|bye for now|that's all(?: for now)?|thats all(?: for now)?|good night|goodnight|go quiet|pause listening)$`);
const STOP_RE = new RegExp(`^${POLITE_PREFIX}(?:stop|stop talking|shush|hush|quiet|be quiet|shut up|enough|pause|okay stop|ok stop)$`);
const CANCEL_RE = new RegExp(`^${POLITE_PREFIX}(?:cancel|cancel (?:that|it|this|the work|that work)|stop (?:working(?: on (?:it|that|this))?|the work|that work|it|that|what you're doing|what youre doing)|abort(?: that| it)?|never ?mind(?:,? (?:stop|cancel)(?: (?:it|that))?)?|don't do (?:that|it)|dont do (?:that|it))$`);
const PROGRESS_RE = new RegExp(`^${POLITE_PREFIX}(?:how(?:'s| is) it going|how(?:'s| is) it coming(?: along)?|how(?:'s| is) that going|how are you doing(?: with that| on that)?|how(?:'s| is) (?:the|that|it) (?:work|job|task) going|what(?:'s| is) it doing(?: now)?|what are you doing(?: now)?|what(?:'s| is) happening|is it (?:done|finished|ready)(?: yet)?|are you (?:done|finished)(?: yet)?|any (?:progress|news|update)|status(?: update)?|progress(?: update)?|still working(?: on it)?|are you still working(?: on it)?|how much longer|where are you at|where(?:'s| is) it at)$`);
const REPEAT_RE = new RegExp(`^${POLITE_PREFIX}(?:say (?:that|it) again|repeat (?:that|it|yourself)|can you repeat (?:that|it)|what (?:was that|did you say)|come again|pardon(?: me)?|sorry what|what)$`);
const FULL_RE = new RegExp(`^${POLITE_PREFIX}(?:read (?:me )?(?:the )?(?:whole|full|entire) (?:thing|reply|message|answer|response)|read (?:it|them) all|read (?:me )?(?:all of it|everything)|read the rest|give me the whole thing|yes read (?:it|the whole thing))$`);
const END_RE = /^(?:end|exit|close|leave|turn off|stop) (?:voice mode|hands[- ]free(?: mode)?)$/;

/** Short commands handled locally without a model round trip. */
export function detectLocalCommand(text: string): LocalVoiceCommand | undefined {
  const normalized = normalizeUtterance(text.replace(/[\u2018\u2019]/g, "'"));
  if (!normalized) return undefined;
  if (END_RE.test(normalized)) return "end";
  if (SLEEP_RE.test(normalized)) return "sleep";
  if (STOP_RE.test(normalized)) return "stop";
  if (CANCEL_RE.test(normalized)) return "cancel";
  if (PROGRESS_RE.test(normalized)) return "progress";
  if (REPEAT_RE.test(normalized)) return "repeat";
  if (FULL_RE.test(normalized)) return "full";
  return undefined;
}

/**
 * Decides whether speech heard while the assistant is talking is a real interruption
 * or a reaction ("yeah", "really?", laughter) that should not cut it off. "Hey Bridge" always is.
 */
export const classifyBargeIn = createBargeInClassifier({ interruptPhrases: ["hey bridge"] });
