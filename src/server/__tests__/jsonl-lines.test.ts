import fs, { writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonlLines, scanJsonlRecords, withoutCarriageReturn } from "../jsonl-lines.js";
import { makeTestDir } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

async function scan(content: string | Buffer, options: Parameters<typeof scanJsonlRecords>[2] = {}) {
  const path = join(makeTestDir("jsonl-records"), "events.jsonl");
  writeFileSync(path, content);
  const file = await open(path, "r");
  try {
    const records: Array<{ text: string; offset: number }> = [];
    const result = await scanJsonlRecords(file, (record, offset) => {
      records.push({ text: record.toString("utf-8"), offset });
    }, options);
    return { records, result };
  } finally {
    await file.close();
  }
}

describe("JSONL records", () => {
  it("reports each record's byte offset across single-byte reads, keeping CR and split UTF-8", async () => {
    const content = "{\"a\":\"\u00e9\u{1f600}\"}\r\n\n{\"b\":2}\n{\"c\":";
    const { records, result } = await scan(content, { chunkBytes: 1 });
    expect(records).toEqual([
      { text: "{\"a\":\"\u00e9\u{1f600}\"}\r", offset: 0 },
      { text: "", offset: Buffer.byteLength("{\"a\":\"\u00e9\u{1f600}\"}\r\n") },
      { text: "{\"b\":2}", offset: Buffer.byteLength("{\"a\":\"\u00e9\u{1f600}\"}\r\n\n") },
    ]);
    expect(result.completeEnd).toBe(Buffer.byteLength(content) - Buffer.byteLength("{\"c\":"));
    expect(result.trailing?.record.toString()).toBe("{\"c\":");
    expect(result.trailing?.offset).toBe(result.completeEnd);
    expect(withoutCarriageReturn(Buffer.from("x\r")).toString()).toBe("x");
    expect(withoutCarriageReturn(Buffer.from("x\ry")).toString()).toBe("x\ry");
  });

  it("reads only the requested range", async () => {
    const { records, result } = await scan("one\ntwo\nthree\nfour\n", { start: 4, end: 13 });
    expect(records).toEqual([{ text: "two", offset: 4 }]);
    expect(result).toEqual({ completeEnd: 8, trailing: { record: Buffer.from("three"), offset: 8 } });
  });

  it("joins a record spanning many reads once instead of copying its growing prefix", async () => {
    const big = `{"payload":"${"x".repeat(4 * 1024 * 1024)}"}`;
    const concat = vi.spyOn(Buffer, "concat");
    const { records } = await scan(`${big}\n{"after":1}\n`, { chunkBytes: 64 * 1024 });
    const copiedBytes = concat.mock.calls.reduce((sum, [, length]) => sum + (length ?? 0), 0);
    expect(records.map((record) => record.text.length)).toEqual([big.length, "{\"after\":1}".length]);
    expect(concat).toHaveBeenCalledTimes(1);
    expect(copiedBytes).toBe(big.length);
  });

  it("refuses a record larger than the limit", async () => {
    await expect(scan(`${"x".repeat(100)}\n`, { chunkBytes: 16, maxRecordBytes: 40 }))
      .rejects.toThrow("JSONL record exceeds 40 bytes at offset 0");
  });

  it("yields between reads but never after the last one", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    await scan("a\nb\nc\n", { chunkBytes: 1024, end: 6, yieldAfterMs: 0 });
    expect(immediate).not.toHaveBeenCalled();
    await scan("a\nb\nc\n", { chunkBytes: 2, end: 6, yieldAfterMs: 0 });
    expect(immediate).toHaveBeenCalledTimes(2);
  });
});

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
