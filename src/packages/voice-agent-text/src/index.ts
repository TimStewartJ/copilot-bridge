export { ON_SCREEN_PHRASE, toSpeakableText, type SpeakableTextOptions } from "./speakable.js";
export { SpokenTextFilter } from "./spoken-filter.js";
export { takeSpeechChunks, type SpeechChunkOptions, type SpeechChunkResult } from "./chunks.js";
export {
  classifyBargeIn,
  countWords,
  createBargeInClassifier,
  createWakePhraseMatcher,
  isFillerUtterance,
  normalizeUtterance,
  type BargeInClassifier,
  type BargeInClassifierOptions,
  type BargeInSpeech,
  type BargeInVerdict,
  type WakeMatch,
  type WakePhraseMatcher,
  type WakePhraseOptions,
} from "./utterance.js";
