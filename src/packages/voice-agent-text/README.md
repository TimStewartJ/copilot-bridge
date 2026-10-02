# voice-agent-text

Text handling for voice agents that speak a language model's replies. Dependency-free, and it runs
wherever JavaScript does.

A voice agent has three text problems that have nothing to do with speech recognition or synthesis:

1. **What to say.** Models answer in Markdown. Reading a table or a code block aloud is useless,
   and telling the model "plain prose only" works until it doesn't.
2. **When to start saying it.** Waiting for the whole reply, or even the whole first sentence,
   costs the pause people notice most.
3. **When to stop.** Someone who says "mhm" or laughs while the agent is talking is not
   interrupting it. Someone who says "wait" is.

```ts
import { SpokenTextFilter, takeSpeechChunks, toSpeakableText } from "voice-agent-text";

const filter = new SpokenTextFilter();
let pending = "";
let spokeAnything = false;

function speakReady(flush: boolean) {
  const { chunks, rest } = takeSpeechChunks(pending, { firstChunk: !spokeAnything, flush });
  pending = rest;
  for (const chunk of chunks) {
    const text = toSpeakableText(chunk);
    if (text) {
      synthesize(text); // your TTS engine
      spokeAnything = true;
    }
  }
}

for await (const delta of llmStream) {
  showOnScreen(delta); // the full reply, structure and all
  pending += filter.push(delta); // only its prose
  speakReady(false);
}
pending += filter.flush();
speakReady(true);
```

Given the reply

```md
Two builds failed overnight.

- api: timeout
- web: lint

Want the details?
```

that loop speaks "Two builds failed overnight." and "Want the details?", and `filter.withheld` is
`true` because the list was shown instead.

## Install

```sh
npm install voice-agent-text
```

ESM only. No dependencies.

## What to say

### `new SpokenTextFilter()`

Feed it the reply as it streams. `push(delta)` returns the part of that delta to speak.

- Prose is spoken. Lists, tables, headings, block quotes and fenced code are withheld.
- Everything after a divider line (`---`) is withheld, so a model can be told "put details below a
  divider", but the filter does not depend on it.
- A line is classified from its first few characters, so prose starts streaming at once. Text that
  only looks like structure is still spoken: `**Bold** start`, `3.5 seconds`, `-5 degrees`,
  `--verbose`, `#1 priority`.
- `withheld` is `true` once anything was held back. Use it to say something like "I've put that on
  screen" when a reply was all structure.
- Call `flush()` when the message ends and `reset()` before the next one.

### `toSpeakableText(text, options?)`

Cleans a chunk for the synthesizer: drops emphasis markers, list markers and emoji, keeps the
label of a link, and replaces what cannot be read. `->` becomes "to", `&` becomes "and", `90%`
becomes "90 percent".

| Option | Default | Said in place of |
|---|---|---|
| `codeBlockPhrase` | `"I've put that on screen."` | a fenced code block |
| `urlPhrase` | `"a link"` | a bare URL |
| `uuidPhrase` | `"that one"` | a UUID |

## When to start

### `takeSpeechChunks(buffer, { firstChunk, flush? })`

Returns `{ chunks, rest }`: the pieces that are ready to synthesize, and the unfinished tail to
carry into the next call.

- A piece is a sentence. Very short ones ("Ok.") are joined to the next so the voice does not stutter.
- While `firstChunk` is true the first piece is cut at an early clause boundary, 15 to 45
  characters in, so audio can start before the first sentence has finished arriving.
- Sentences longer than 240 characters are cut at clause boundaries.
- Pass `flush: true` at the end of the reply to get the tail.

## When to stop

### `classifyBargeIn(text, { speechMs, final })`

Call it with what the recognizer heard while the agent was speaking. `speechMs` is how long the
person has been talking, and `final` says whether `text` is a final transcript or a partial one.

| Verdict | Meaning | Examples |
|---|---|---|
| `"stop"` | A real interruption: stop speaking and listen. | "wait", "actually, tell me a joke instead", anything that lasts 2.5 seconds or more |
| `"ignore"` | A reaction or noise, judged on a final transcript: keep speaking. | "yeah", "really?", "that's so funny", "haha" |
| `"undecided"` | Too little so far, on a partial transcript: keep speaking and ask again. | "tell me", "yeah" |

`createBargeInClassifier({ interruptPhrases, backchannelWords, longSpeechMs })` builds one with
extra phrases that always interrupt (typically the wake phrase), extra reaction words, or a
different limit for long speech.

### Other helpers

- `isFillerUtterance(text)`: true for silence, breath noise, "um", "huh".
- `createWakePhraseMatcher({ names, greetings? })`: `match(text)` finds "hey <name> ..." or
  "<name> ..." at the start of an utterance and returns what followed; `stripLeading(text)`
  removes a greeted name. List the ways your recognizer mishears the name.
- `normalizeUtterance(text)` and `countWords(text)`: lowercase words without punctuation, for
  matching your own short commands ("stop", "go to sleep") without a model round trip.

## Limits

- The word lists (fillers, reactions, interruptions, greetings) are English. The filter and the
  chunker depend on Markdown and on punctuation, not on a language, but have only been used with
  English.
- The rules are heuristics tuned on one assistant's conversations. They are meant to be cheap and
  predictable, and they will sometimes be wrong.
- The filter withholds structure rather than narrating it. To have lists and code read aloud in
  full, use a Markdown-to-speech narrator instead (`speakable-text` is one).

## License

MIT
