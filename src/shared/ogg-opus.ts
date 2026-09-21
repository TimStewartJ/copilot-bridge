// The Ogg Opus container (RFC 7845), just enough for chat mic recordings: the browser writes one
// mono stream, the server reads it back. Staying on the standard container keeps a stored recording
// playable in any audio tool when something needs a listen.

/** Opus counts time in 48 kHz samples whatever rate the audio was captured at. */
export const OPUS_CLOCK_RATE = 48_000;

export class OggOpusError extends Error {}

export interface OggOpusStream {
  channels: number;
  /** Samples at 48 kHz that a decoder drops from the start to undo the encoder's delay. */
  preSkip: number;
  /** Rate the audio was captured at. Informational: Opus decodes to any of its rates. */
  inputSampleRate: number;
  packets: Uint8Array[];
  /**
   * Where the recording ends, in 48 kHz samples from the start of the first packet. An encoder pads
   * its last packet to a whole frame; this says how much of the stream is audio, and a reader drops
   * the rest (RFC 7845 section 4.4). Absent means all of it.
   */
  endSample?: number;
}

const CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53];
const PAGE_HEADER_BYTES = 27;
const MAX_PAGE_SEGMENTS = 255;
const MAX_PAGE_SAMPLES = OPUS_CLOCK_RATE;
const HEADER_BEGINS_STREAM = 0x02;
const HEADER_ENDS_STREAM = 0x04;
const HEADER_CONTINUES_PACKET = 0x01;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let remainder = i << 24;
    for (let bit = 0; bit < 8; bit++) remainder = remainder & 0x80000000 ? (remainder << 1) ^ 0x04c11db7 : remainder << 1;
    table[i] = remainder >>> 0;
  }
  return table;
})();

/** Ogg's page checksum: CRC-32 with polynomial 0x04c11db7, no reflection, computed with the checksum field zeroed. */
export function oggPageChecksum(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const value = i >= 22 && i < 26 ? 0 : page[i]!;
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ value) & 0xff]!) >>> 0;
  }
  return crc;
}

export function isOggOpus(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && CAPTURE_PATTERN.every((value, index) => bytes[index] === value);
}

const SILK_FRAME_MS = [10, 20, 40, 60];
const HYBRID_FRAME_MS = [10, 20];
const CELT_FRAME_MS = [2.5, 5, 10, 20];

/** Length of one Opus packet in 48 kHz samples (RFC 6716 section 3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) throw new OggOpusError("Opus recording contains an empty packet.");
  const config = packet[0]! >> 3;
  const frameMs = config < 12 ? SILK_FRAME_MS[config % 4]! : config < 16 ? HYBRID_FRAME_MS[config % 2]! : CELT_FRAME_MS[config % 4]!;
  const framing = packet[0]! & 0x03;
  const frames = framing === 0 ? 1 : framing < 3 ? 2 : packet.length > 1 ? packet[1]! & 0x3f : 0;
  const samples = frames * frameMs * (OPUS_CLOCK_RATE / 1000);
  if (samples <= 0 || samples > OPUS_CLOCK_RATE * 0.12) throw new OggOpusError("Opus recording contains an invalid packet duration.");
  return samples;
}

/**
 * Playable length of a stream: up to where it says the recording ends, less the encoder delay. The
 * packets bound it, so a stream cannot claim more audio than it carries, and a reader that trims to
 * this length plays exactly what was measured.
 */
export function oggOpusDurationSeconds(stream: Pick<OggOpusStream, "packets" | "preSkip" | "endSample">): number {
  const samples = stream.packets.reduce((sum, packet) => sum + opusPacketSamples(packet), 0);
  return Math.max(0, Math.min(samples, stream.endSample ?? samples) - stream.preSkip) / OPUS_CLOCK_RATE;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function buildPage(serial: number, sequence: number, flags: number, granule: number, packets: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let rest = packet.length; rest >= 255; rest -= 255) lacing.push(255);
    lacing.push(packet.length % 255);
  }
  const bodyBytes = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(PAGE_HEADER_BYTES + lacing.length + bodyBytes);
  const view = new DataView(page.buffer);
  page.set(CAPTURE_PATTERN, 0);
  page[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, PAGE_HEADER_BYTES);
  let offset = PAGE_HEADER_BYTES + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggPageChecksum(page), true);
  return page;
}

/** Writes a stream as Ogg Opus, about a second of audio to a page. */
export function muxOggOpus(stream: OggOpusStream, serial = 1): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(19);
  head.set(ascii("OpusHead"), 0);
  head[8] = 1;
  head[9] = stream.channels;
  new DataView(head.buffer).setUint16(10, stream.preSkip, true);
  new DataView(head.buffer).setUint32(12, stream.inputSampleRate, true);
  const vendor = ascii("copilot-bridge");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(ascii("OpusTags"), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const pages = [buildPage(serial, 0, HEADER_BEGINS_STREAM, 0, [head]), buildPage(serial, 1, 0, 0, [tags])];
  let granule = 0;
  let previousPageGranule = 0;
  let pending: Uint8Array[] = [];
  let pendingSegments = 0;
  let pendingSamples = 0;
  const flush = (last: boolean) => {
    if (pending.length === 0 && !last) return;
    // Only the last page may stop short of its packets: that is how the end of the recording is marked.
    const pageGranule = last ? Math.max(previousPageGranule, Math.min(granule, stream.endSample ?? granule)) : granule;
    pages.push(buildPage(serial, pages.length, last ? HEADER_ENDS_STREAM : 0, pageGranule, pending));
    previousPageGranule = pageGranule;
    pending = [];
    pendingSegments = 0;
    pendingSamples = 0;
  };
  for (const packet of stream.packets) {
    const segments = Math.floor(packet.length / 255) + 1;
    if (segments > MAX_PAGE_SEGMENTS) throw new OggOpusError("Opus packet exceeds the supported page size.");
    if (pendingSegments + segments > MAX_PAGE_SEGMENTS || pendingSamples >= MAX_PAGE_SAMPLES) flush(false);
    pending.push(packet);
    pendingSegments += segments;
    pendingSamples += opusPacketSamples(packet);
    granule += opusPacketSamples(packet);
  }
  flush(true);

  const file = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0));
  let offset = 0;
  for (const page of pages) {
    file.set(page, offset);
    offset += page.length;
  }
  return file;
}

/** Reads a complete first Opus stream; damaged or missing pages must not become a partial transcript. */
export function demuxOggOpus(bytes: Uint8Array): OggOpusStream {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Uint8Array[] = [];
  let serial: number | undefined;
  let sequence = 0;
  let partial: Uint8Array[] = [];
  let partialBytes = 0;
  let decodedSamples = 0;
  let previousGranule = 0;
  let endSample: number | undefined;
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + PAGE_HEADER_BYTES > bytes.length) throw new OggOpusError("Ogg recording is truncated.");
    if (!CAPTURE_PATTERN.every((value, index) => bytes[offset + index] === value) || bytes[offset + 4] !== 0) {
      throw new OggOpusError("Recording is not a valid Ogg file.");
    }
    const flags = bytes[offset + 5]!;
    const pageSerial = view.getUint32(offset + 14, true);
    const segmentCount = bytes[offset + 26]!;
    const tableStart = offset + PAGE_HEADER_BYTES;
    let bodyStart = tableStart + segmentCount;
    if (bodyStart > bytes.length) throw new OggOpusError("Ogg recording is truncated.");
    const pageEnd = bodyStart + bytes.subarray(tableStart, bodyStart).reduce((sum, length) => sum + length, 0);
    if (pageEnd > bytes.length) throw new OggOpusError("Ogg recording is truncated.");
    if (oggPageChecksum(bytes.subarray(offset, pageEnd)) !== view.getUint32(offset + 22, true)) {
      throw new OggOpusError("Ogg recording checksum failed.");
    }

    serial ??= pageSerial;
    if (pageSerial === serial) {
      if (endSample !== undefined || view.getUint32(offset + 18, true) !== sequence
        || Boolean(flags & HEADER_BEGINS_STREAM) !== (sequence === 0)) {
        throw new OggOpusError("Ogg recording contains missing or out-of-order pages.");
      }
      if (Boolean(flags & HEADER_CONTINUES_PACKET) !== (partial.length > 0)) {
        throw new OggOpusError("Ogg recording contains an incomplete packet.");
      }
      sequence++;
      for (let segment = 0; segment < segmentCount; segment++) {
        const length = bytes[tableStart + segment]!;
        partialBytes += length;
        if (partialBytes > MAX_PAGE_SEGMENTS * 255) throw new OggOpusError("Opus packet exceeds the supported size.");
        partial.push(bytes.subarray(bodyStart, bodyStart + length));
        if (length < 255) {
          const packet = partial.length === 1 ? partial[0]! : concat(partial);
          if (packets.length >= 2) decodedSamples += opusPacketSamples(packet);
          packets.push(packet);
          partial = [];
          partialBytes = 0;
        }
        bodyStart += length;
      }
      const granule = view.getBigInt64(offset + 6, true);
      if (granule < -1n || granule > BigInt(Number.MAX_SAFE_INTEGER)) throw new OggOpusError("Ogg recording has an invalid sample position.");
      if (granule >= 0n) {
        const position = Number(granule);
        if (position < previousGranule || position > decodedSamples
          || (!(flags & HEADER_ENDS_STREAM) && position !== decodedSamples)) {
          throw new OggOpusError("Ogg recording has an invalid sample position.");
        }
        previousGranule = position;
        if (flags & HEADER_ENDS_STREAM) endSample = position;
      }
    }
    offset = pageEnd;
  }
  if (partial.length > 0 || endSample === undefined) throw new OggOpusError("Ogg recording is truncated.");

  const head = packets[0];
  if (!head || head.length < 19 || String.fromCharCode(...head.subarray(0, 8)) !== "OpusHead") {
    throw new OggOpusError("Ogg recording does not contain Opus audio.");
  }
  if (head[8] !== 1 || head[18] !== 0 || head[9]! < 1 || head[9]! > 2) {
    throw new OggOpusError("Only version 1 mono or stereo Opus recordings are supported.");
  }
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (headView.getInt16(16, true) !== 0) throw new OggOpusError("Opus recordings with output gain are unsupported.");
  const tags = packets[1];
  if (!tags || tags.length < 16 || String.fromCharCode(...tags.subarray(0, 8)) !== "OpusTags") {
    throw new OggOpusError("Ogg recording is missing its OpusTags header.");
  }
  return {
    channels: head[9]!,
    preSkip: headView.getUint16(10, true),
    inputSampleRate: headView.getUint32(12, true),
    packets: packets.slice(2),
    endSample,
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}
