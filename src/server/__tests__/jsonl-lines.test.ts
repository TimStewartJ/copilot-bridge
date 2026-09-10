import fs, { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonlLines } from "../jsonl-lines.js";
import { makeTestDir } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

describe("JSONL physical lines", () => {
  it("preserves Unicode separators and split UTF-8 chunks with CRLF and unterminated EOF", async () => {
    const path = join(makeTestDir("jsonl-lines"), "events.jsonl");
    const records = ['{"text":"a\u2028b\u2029c"}', "", '{"text":"last"}'];
    writeFileSync(path, records.join("\r\n"));
    const original = fs.createReadStream;
    vi.spyOn(fs, "createReadStream").mockImplementation((file, options) =>
      original(file, { ...(typeof options === "object" ? options : {}), encoding: "utf8", highWaterMark: 1 }));
    syncBuiltinESMExports();
    const lines: string[] = [];
    for await (const line of readJsonlLines(path)) lines.push(line);
    expect(lines).toEqual(records);
    expect(JSON.parse(lines[0]!)).toEqual({ text: "a\u2028b\u2029c" });
  });

  it("does not invent a record after a final LF and preserves a bare CR", async () => {
    const path = join(makeTestDir("jsonl-lf"), "events.jsonl");
    writeFileSync(path, "a\rb\n");
    const lines: string[] = [];
    for await (const line of readJsonlLines(path)) lines.push(line);
    expect(lines).toEqual(["a\rb"]);
  });

  it("propagates read failures", async () => {
    const iterator = readJsonlLines(join(makeTestDir("jsonl-missing"), "missing.jsonl"));
    await expect(iterator.next()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("destroys its stream when a consumer exits early", async () => {
    const path = join(makeTestDir("jsonl-close"), "events.jsonl");
    writeFileSync(path, "first\nsecond\n");
    const original = fs.createReadStream;
    let stream: fs.ReadStream | undefined;
    vi.spyOn(fs, "createReadStream").mockImplementation((file, options) => {
      stream = original(file, options);
      return stream;
    });
    syncBuiltinESMExports();
    for await (const line of readJsonlLines(path)) {
      expect(line).toBe("first");
      break;
    }
    expect(stream?.destroyed).toBe(true);
  });
});
