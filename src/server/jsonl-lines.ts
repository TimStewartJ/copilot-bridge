import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";

const DEFAULT_RECORD_CHUNK_BYTES = 256 * 1024;
const DEFAULT_YIELD_AFTER_MS = 12;

export interface JsonlRecordScanOptions {
  /** First byte to read; defaults to 0. */
  start?: number;
  /** Byte to stop before; defaults to the end of the file. */
  end?: number;
  chunkBytes?: number;
  /** Throw instead of buffering a record that grows past this many bytes. */
  maxRecordBytes?: number;
  /** Hand the event loop back between reads once this much synchronous work has run; 0 yields between every read. */
  yieldAfterMs?: number;
}

export interface JsonlRecordScan {
  /** Offset just past the last LF: where the next complete record would start. */
  completeEnd: number;
  /** Bytes after the last LF: a record still being written, or a file without a final LF. */
  trailing?: { record: Buffer; offset: number };
}

/**
 * Calls `onRecord` with each LF-terminated record of `file` (without its LF; a CR is kept) and
 * the record's byte offset. A record split across reads is joined once, when its LF arrives, so a
 * huge record costs its own size instead of a copy of its growing prefix per read. `record` may be
 * a view of the reused read buffer and is valid only until `onRecord` returns.
 */
export async function scanJsonlRecords(
  file: FileHandle,
  onRecord: (record: Buffer, offset: number) => void,
  options: JsonlRecordScanOptions = {},
): Promise<JsonlRecordScan> {
  const end = options.end ?? Number.POSITIVE_INFINITY;
  const yieldAfterMs = options.yieldAfterMs ?? DEFAULT_YIELD_AFTER_MS;
  const buffer = Buffer.alloc(options.chunkBytes ?? DEFAULT_RECORD_CHUNK_BYTES);
  let position = options.start ?? 0;
  let completeEnd = position;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let pendingOffset = position;
  let sliceStartedAt = performance.now();

  while (position < end) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let recordStart = 0;
    for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, recordStart)) {
      const piece = chunk.subarray(recordStart, newline);
      if (pendingBytes > 0) {
        onRecord(Buffer.concat([...pending, piece], pendingBytes + piece.length), pendingOffset);
        pending = [];
        pendingBytes = 0;
      } else {
        onRecord(piece, position + recordStart);
      }
      recordStart = newline + 1;
      completeEnd = position + recordStart;
    }
    if (recordStart < bytesRead) {
      if (pendingBytes === 0) pendingOffset = position + recordStart;
      const fragment = Buffer.from(chunk.subarray(recordStart));
      pending.push(fragment);
      pendingBytes += fragment.length;
      if (options.maxRecordBytes !== undefined && pendingBytes > options.maxRecordBytes) {
        throw new Error(`JSONL record exceeds ${options.maxRecordBytes} bytes at offset ${pendingOffset}`);
      }
    }
    position += bytesRead;
    if (position < end && performance.now() - sliceStartedAt >= yieldAfterMs) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStartedAt = performance.now();
    }
  }

  return pendingBytes > 0
    ? { completeEnd, trailing: { record: Buffer.concat(pending, pendingBytes), offset: pendingOffset } }
    : { completeEnd };
}

/** A record's bytes without the CR of a CRLF line ending. */
export function withoutCarriageReturn(record: Buffer): Buffer {
  return record.length > 0 && record[record.length - 1] === 0x0d ? record.subarray(0, -1) : record;
}

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
