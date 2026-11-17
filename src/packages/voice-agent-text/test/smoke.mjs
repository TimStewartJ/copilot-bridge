// Run by packages:verify against the packed tarball; it is also the README's streaming loop.
import assert from "node:assert/strict";
import {
  classifyBargeIn,
  createWakePhraseMatcher,
  SpokenTextFilter,
  takeSpeechChunks,
  toSpeakableText,
} from "voice-agent-text";

const reply = "Two builds failed overnight.\n\n- api: timeout\n- web: lint\n\nWant the details?";
const filter = new SpokenTextFilter();
const spoken = [];
let pending = "";
const speak = (flush) => {
  const { chunks, rest } = takeSpeechChunks(pending, { firstChunk: spoken.length === 0, flush });
  pending = rest;
  spoken.push(...chunks.map((chunk) => toSpeakableText(chunk)).filter(Boolean));
};
for (let index = 0; index < reply.length; index += 4) {
  pending += filter.push(reply.slice(index, index + 4));
  speak(false);
}
pending += filter.flush();
speak(true);

assert.deepEqual(spoken, ["Two builds failed overnight.", "Want the details?"]);
assert.equal(filter.withheld, true);
assert.equal(classifyBargeIn("mhm", { speechMs: 300, final: true }), "ignore");
assert.equal(classifyBargeIn("wait, stop", { speechMs: 300, final: false }), "stop");
assert.deepEqual(createWakePhraseMatcher({ names: ["computer"] }).match("Hey computer, lights on"), { remainder: "lights on" });
console.log("voice-agent-text smoke passed: spoke the prose of a streamed reply and withheld its list");
