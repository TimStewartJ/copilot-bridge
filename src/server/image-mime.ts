// Label images by magic bytes: Anthropic rejects a mismatched type and it can wedge the session.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DATA_URI_BASE64_PREFIX = /^data:[^;,]*;base64,/i;

/** Raster image MIME type from leading magic bytes; undefined for an unknown signature. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const b = bytes;

  if (b.length >= 8 && PNG_SIGNATURE.every((value, index) => b[index] === value)) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 6
    && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
    && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
    return "image/bmp";
  }
  return undefined;
}

/** Sniff MIME from base64 (optional data: prefix), decoding only a short prefix. */
export function sniffImageMimeFromBase64(data: string): string | undefined {
  if (typeof data !== "string") return undefined;

  const withoutPrefix = data.trim().replace(DATA_URI_BASE64_PREFIX, "");
  // Strip whitespace (line-wrapped base64) from a bounded prefix; 18 bytes covers every signature.
  const head = withoutPrefix.slice(0, 128).replace(/\s+/g, "").slice(0, 24);
  const aligned = head.slice(0, head.length - (head.length % 4));
  if (aligned.length < 4) return undefined;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(aligned, "base64");
  } catch {
    return undefined;
  }
  return sniffImageMime(bytes);
}
