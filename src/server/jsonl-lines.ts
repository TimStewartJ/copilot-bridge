import { createReadStream } from "node:fs";

export async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  let pending = "";
  try {
    for await (const chunk of stream) {
      const text: string = chunk;
      let start = 0;
      let end = text.indexOf("\n");
      while (end !== -1) {
        const line = pending + text.slice(start, end);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        pending = "";
        start = end + 1;
        end = text.indexOf("\n", start);
      }
      // JSONL records end only at LF; Unicode separators inside JSON strings are data.
      pending += text.slice(start);
    }
    if (pending) yield pending;
  } finally {
    stream.destroy();
  }
}
