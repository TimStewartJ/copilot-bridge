import { describe, expect, it } from "vitest";
import { OGG_OPUS_TONE_SECONDS, oggOpusToneFixture } from "../test-support/ogg-opus-fixture.js";
import {
  demuxOggOpus,
  isOggOpus,
  muxOggOpus,
  OggOpusError,
  oggOpusDurationSeconds,
  oggPageChecksum,
  opusPacketSamples,
} from "./ogg-opus.js";

/** A packet that is only a valid first byte and padding: enough for everything but decoding. */
function packet(firstByte: number, length: number, fill = 0xa5): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill);
  bytes[0] = firstByte;
  return bytes;
}

const WIDEBAND_20_MS = 0x48;

function updateChecksum(file: Uint8Array, offset = 0): void {
  const segments = file[offset + 26]!;
  const end = offset + 27 + segments + file.subarray(offset + 27, offset + 27 + segments).reduce((sum, length) => sum + length, 0);
  new DataView(file.buffer, file.byteOffset, file.byteLength).setUint32(offset + 22, oggPageChecksum(file.subarray(offset, end)), true);
}

describe("opusPacketSamples", () => {
  it("reads a packet's length from its first bytes", () => {
    expect(opusPacketSamples(packet(WIDEBAND_20_MS, 40))).toBe(960);
    expect(opusPacketSamples(packet(0x00, 40))).toBe(480); // narrowband speech, 10 ms
    expect(opusPacketSamples(packet(0x58, 40))).toBe(2_880); // wideband speech, 60 ms
    expect(opusPacketSamples(packet(0x68, 40))).toBe(960); // hybrid, 20 ms
    expect(opusPacketSamples(packet(0x80, 40))).toBe(120); // music mode, 2.5 ms
    expect(opusPacketSamples(packet(WIDEBAND_20_MS | 1, 40))).toBe(1_920); // two frames
    expect(opusPacketSamples(new Uint8Array([WIDEBAND_20_MS | 3, 3, 0, 0]))).toBe(2_880); // three frames, counted
    expect(() => opusPacketSamples(new Uint8Array(0))).toThrow("empty packet");
    expect(() => opusPacketSamples(new Uint8Array([0x4b]))).toThrow("invalid packet duration");
    expect(() => opusPacketSamples(new Uint8Array([0x4b, 7]))).toThrow("invalid packet duration");
  });
});

describe("a standard Ogg Opus file", () => {
  it("is recognised, read, and measured without decoding it", () => {
    const file = oggOpusToneFixture();
    expect(isOggOpus(file)).toBe(true);
    expect(isOggOpus(new TextEncoder().encode("RIFF....WAVE"))).toBe(false);

    const stream = demuxOggOpus(file);
    expect(stream).toMatchObject({ channels: 1, preSkip: 312, inputSampleRate: 16_000 });
    expect(stream.packets.length).toBeGreaterThan(15);
    expect(stream.packets.every((entry) => opusPacketSamples(entry) === 960)).toBe(true);
    expect(oggOpusDurationSeconds(stream)).toBeCloseTo(OGG_OPUS_TONE_SECONDS, 1);
  });

  it("carries page checksums this module computes the same way", () => {
    const file = oggOpusToneFixture();
    const segments = file[26]!;
    const firstPage = file.slice(0, 27 + segments + file.subarray(27, 27 + segments).reduce((sum, length) => sum + length, 0));
    const stored = new DataView(firstPage.buffer).getUint32(22, true);
    firstPage.fill(0, 22, 26);
    expect(oggPageChecksum(firstPage)).toBe(stored);
  });
});

describe("muxOggOpus", () => {
  it("writes a stream that reads back packet for packet", () => {
    // Sizes around the 255-byte lacing boundary, and enough packets to need several pages.
    const packets = [1, 254, 255, 256, 510, 700].map((length) => packet(WIDEBAND_20_MS, length))
      .concat(Array.from({ length: 400 }, (_, index) => packet(WIDEBAND_20_MS, 60 + (index % 7), index)));

    const file = muxOggOpus({ channels: 1, preSkip: 104, inputSampleRate: 16_000, packets });
    const stream = demuxOggOpus(file);

    expect(stream).toMatchObject({ channels: 1, preSkip: 104, inputSampleRate: 16_000 });
    expect(stream.packets.map((entry) => [...entry])).toEqual(packets.map((entry) => [...entry]));
    expect(oggOpusDurationSeconds(stream)).toBeCloseTo((packets.length * 960 - 104) / 48_000, 6);
  });

  it("marks where the stream begins and ends, numbers its pages, and checksums each one", () => {
    const file = muxOggOpus({ channels: 1, preSkip: 312, inputSampleRate: 16_000, packets: Array.from({ length: 120 }, () => packet(WIDEBAND_20_MS, 50)) });
    const pages: Array<{ flags: number; sequence: number; granule: number; valid: boolean }> = [];
    for (let offset = 0; offset < file.length;) {
      const segments = file[offset + 26]!;
      const length = 27 + segments + file.subarray(offset + 27, offset + 27 + segments).reduce((sum, value) => sum + value, 0);
      const page = file.slice(offset, offset + length);
      const view = new DataView(page.buffer);
      const stored = view.getUint32(22, true);
      page.fill(0, 22, 26);
      pages.push({ flags: page[5]!, sequence: view.getUint32(18, true), granule: Number(view.getBigUint64(6, true)), valid: oggPageChecksum(page) === stored });
      offset += length;
    }

    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index));
    expect(pages.every((page) => page.valid)).toBe(true);
    expect(pages[0]!.flags).toBe(0x02);
    expect(pages.at(-1)!.flags).toBe(0x04);
    // Two header pages, then about a second of audio to a page, each stamped with the running length.
    expect(pages.slice(2).map((page) => page.granule)).toEqual([48_000, 96_000, 115_200]);
  });
});

describe("where a recording ends", () => {
  const packets = Array.from({ length: 51 }, () => packet(WIDEBAND_20_MS, 50));

  it("is marked on the last page and read back, so a padded last packet does not lengthen it", () => {
    // One second of audio behind a 312-sample encoder delay; the encoder rounded up to 51 packets.
    const file = muxOggOpus({ channels: 1, preSkip: 312, inputSampleRate: 16_000, packets, endSample: 312 + 48_000 });
    const stream = demuxOggOpus(file);
    expect(stream.endSample).toBe(48_312);
    expect(oggOpusDurationSeconds(stream)).toBe(1);
    expect(oggOpusDurationSeconds({ ...stream, endSample: undefined })).toBeCloseTo(1.0135, 4);
  });

  it("never reaches past the audio the stream carries", () => {
    const stream = demuxOggOpus(muxOggOpus({ channels: 1, preSkip: 312, inputSampleRate: 16_000, packets, endSample: 10_000_000 }));
    expect(stream.endSample).toBe(51 * 960);
    expect(oggOpusDurationSeconds({ ...stream, endSample: 10_000_000 })).toBeCloseTo((51 * 960 - 312) / 48_000, 6);
  });
});

describe("demuxOggOpus", () => {
  it("reassembles a packet that continues across pages and ignores other streams", () => {
    const stream = demuxOggOpus(oggOpusToneFixture());
    const long = packet(WIDEBAND_20_MS, 600);
    const base = muxOggOpus({ ...stream, packets: [] });
    // Hand-built pages: the first ends mid-packet (a final lacing value of 255), the second continues it.
    const page = (flags: number, sequence: number, serial: number, lacing: number[], body: Uint8Array) => {
      const bytes = new Uint8Array(27 + lacing.length + body.length);
      bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
      bytes[5] = flags;
      new DataView(bytes.buffer).setUint32(14, serial, true);
      new DataView(bytes.buffer).setUint32(18, sequence, true);
      bytes[26] = lacing.length;
      bytes.set(lacing, 27);
      bytes.set(body, 27 + lacing.length);
      new DataView(bytes.buffer).setBigInt64(6, flags & 0x04 ? 960n : -1n, true);
      updateChecksum(bytes);
      return bytes;
    };
    const withoutEnd = base.slice(0, base.length - 27);
    const file = new Uint8Array([
      ...withoutEnd,
      ...page(0, 2, 1, [255, 255], long.subarray(0, 510)),
      ...page(0, 0, 99, [4], new Uint8Array([9, 9, 9, 9])),
      ...page(0x01 | 0x04, 3, 1, [90], long.subarray(510)),
    ]);

    expect(demuxOggOpus(file).packets.map((entry) => [...entry])).toEqual([[...long]]);
  });

  it("rejects what is not a complete Ogg Opus recording", () => {
    const file = oggOpusToneFixture();
    expect(() => demuxOggOpus(new TextEncoder().encode("not an ogg file, but long enough to look at"))).toThrow(OggOpusError);
    expect(() => demuxOggOpus(file.slice(0, file.length - 40))).toThrow("truncated");
    const vorbis = file.slice();
    vorbis.set(new TextEncoder().encode("vorbis!!"), 28);
    updateChecksum(vorbis);
    expect(() => demuxOggOpus(vorbis)).toThrow("does not contain Opus audio");
  });

  it("refuses payload corruption, missing pages, trailing truncation and false duration claims", () => {
    const file = muxOggOpus({ channels: 1, preSkip: 312, inputSampleRate: 48_000,
      packets: Array.from({ length: 120 }, () => packet(WIDEBAND_20_MS, 50)) });
    const offsets: number[] = [];
    for (let offset = 0; offset < file.length;) {
      offsets.push(offset);
      const segments = file[offset + 26]!;
      offset += 27 + segments + file.subarray(offset + 27, offset + 27 + segments).reduce((sum, length) => sum + length, 0);
    }
    const corrupt = file.slice();
    corrupt[corrupt.length - 1]! ^= 1;
    expect(() => demuxOggOpus(corrupt)).toThrow("checksum failed");
    expect(() => demuxOggOpus(file.subarray(0, offsets.at(-1)!))).toThrow("truncated");
    expect(() => demuxOggOpus(new Uint8Array([...file, 0, 0]))).toThrow("truncated");

    const missingPage = file.slice();
    new DataView(missingPage.buffer).setUint32(offsets[2]! + 18, 3, true);
    updateChecksum(missingPage, offsets[2]!);
    expect(() => demuxOggOpus(missingPage)).toThrow("out-of-order pages");

    const falseDuration = file.slice();
    new DataView(falseDuration.buffer).setBigInt64(offsets.at(-1)! + 6, 10_000_000n, true);
    updateChecksum(falseDuration, offsets.at(-1)!);
    expect(() => demuxOggOpus(falseDuration)).toThrow("invalid sample position");
  });
});
