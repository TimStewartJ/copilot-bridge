// How to cut streamed text into pieces a speech synthesizer can start on early.

export interface SpeechChunkResult {
  /** Pieces that are ready to synthesize, in order. */
  chunks: string[];
  /** Text that does not end a sentence yet. Prepend it to the next delta and call again. */
  rest: string;
}

export interface SpeechChunkOptions {
  /** True while nothing of this reply has been spoken yet: the first piece is cut short so audio starts sooner. */
  firstChunk: boolean;
  /** The reply has ended: emit whatever is left, even without sentence-ending punctuation. */
  flush?: boolean;
}

const SENTENCE_END_RE = /[.!?\u2026]+["')\]]*(?=\s)|\n+/g;
const MIN_SENTENCE_CHARS = 12;
const FIRST_CLAUSE_MIN = 15;
const FIRST_CLAUSE_MAX = 45;
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
export function takeSpeechChunks(buffer: string, options: SpeechChunkOptions): SpeechChunkResult {
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
      const clause = rest.match(/^([\s\S]{15,45}?[,;:\u2014\u2013])\s+/);
      if (clause) {
        sentences.push(clause[1]!.trim());
        rest = rest.slice(clause[0].length);
      }
    }
  }

  return { chunks: sentences.flatMap(splitLongChunk), rest };
}
