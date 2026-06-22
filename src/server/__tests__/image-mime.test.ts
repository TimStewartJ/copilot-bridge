import { describe, expect, it } from "vitest";

import { sniffImageMime, sniffImageMimeFromBase64 } from "../image-mime.js";

const SAMPLES: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01],
  "image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
  "image/bmp": [0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00],
};

describe("sniffImageMime", () => {
  for (const [mime, bytes] of Object.entries(SAMPLES)) {
    it(`detects ${mime} from magic bytes`, () => {
      expect(sniffImageMime(Uint8Array.from(bytes))).toBe(mime);
    });
  }

  it("detects GIF87a as well as GIF89a", () => {
    expect(sniffImageMime(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]))).toBe("image/gif");
  });

  it("returns undefined for unknown bytes", () => {
    expect(sniffImageMime(Uint8Array.from([0x70, 0x6e, 0x67, 0x00]))).toBeUndefined();
  });

  it("returns undefined for too-short input", () => {
    expect(sniffImageMime(Uint8Array.from([0xff, 0xd8]))).toBeUndefined();
    expect(sniffImageMime(Uint8Array.from([]))).toBeUndefined();
  });

  it("does not misclassify a RIFF container that is not WEBP", () => {
    const riffWave = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
    expect(sniffImageMime(Uint8Array.from(riffWave))).toBeUndefined();
  });
});

describe("sniffImageMimeFromBase64", () => {
  function b64(bytes: number[]): string {
    return Buffer.from(bytes).toString("base64");
  }

  it("detects each format from base64", () => {
    for (const [mime, bytes] of Object.entries(SAMPLES)) {
      expect(sniffImageMimeFromBase64(b64(bytes))).toBe(mime);
    }
  });

  it("identifies the real format when the label would be wrong (jpeg bytes)", () => {
    expect(sniffImageMimeFromBase64(b64(SAMPLES["image/jpeg"]))).toBe("image/jpeg");
  });

  it("strips a data URI prefix (case-insensitive)", () => {
    const data = `DATA:image/png;BASE64,${b64(SAMPLES["image/jpeg"])}`;
    expect(sniffImageMimeFromBase64(data)).toBe("image/jpeg");
  });

  it("ignores surrounding whitespace", () => {
    expect(sniffImageMimeFromBase64(`  \n${b64(SAMPLES["image/png"])}\n`)).toBe("image/png");
  });

  it("returns undefined for non-image base64", () => {
    expect(sniffImageMimeFromBase64(Buffer.from("hello world payload").toString("base64"))).toBeUndefined();
  });

  it("detects format despite internal line-wrapping whitespace", () => {
    const raw = b64(SAMPLES["image/jpeg"]);
    const wrapped = `${raw.slice(0, 4)}\n${raw.slice(4, 8)}\r\n${raw.slice(8)}`;
    expect(sniffImageMimeFromBase64(wrapped)).toBe("image/jpeg");
  });

  it("returns undefined for empty or tiny input", () => {
    expect(sniffImageMimeFromBase64("")).toBeUndefined();
    expect(sniffImageMimeFromBase64("AA==")).toBeUndefined();
  });
});
