// Keep the PCM alongside this optional encoding so every compression failure can fall back to WAV.
import { muxOggOpus, OPUS_CLOCK_RATE, opusPacketSamples } from "../../shared/ogg-opus.js";

export const OPUS_RECORDING_MIME_TYPE = "audio/ogg";
const OPUS_BITRATE = 32_000;
const FLUSH_TIMEOUT_MS = 15_000;

export interface OpusRecordingEncoder {
  push(samples: Float32Array<ArrayBuffer>): void;
  finish(): Promise<Blob | null>;
  cancel(): void;
}

export async function createOpusRecordingEncoder(sampleRate: number): Promise<OpusRecordingEncoder | null> {
  // Chromium reports its delay in input-rate samples, while Ogg requires 48 kHz samples. Using
  // the Ogg clock for capture and encoding avoids browser-specific delay conversions.
  if (sampleRate !== OPUS_CLOCK_RATE || typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;
  const config: AudioEncoderConfig = { codec: "opus", sampleRate, numberOfChannels: 1, bitrate: OPUS_BITRATE };
  const packets: Uint8Array[] = [];
  let preSkip: number | null = null;
  let pushedSamples = 0;
  let failed = false;
  const fail = (reason: unknown) => {
    if (!failed) console.warn("[voice-input] Opus compression failed; using WAV.", reason);
    failed = true;
    packets.length = 0;
  };

  let encoder: AudioEncoder | undefined;
  const close = () => {
    if (encoder && encoder.state !== "closed") encoder.close();
  };
  try {
    if (!(await AudioEncoder.isConfigSupported(config)).supported) return null;
    encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (failed) return;
        try {
          const packet = new Uint8Array(chunk.byteLength);
          chunk.copyTo(packet);
          packets.push(packet);
          const description = metadata?.decoderConfig?.description;
          if (description) {
            const header = ArrayBuffer.isView(description)
              ? new DataView(description.buffer, description.byteOffset, description.byteLength)
              : new DataView(description);
            if (header.byteLength < 19 || String.fromCharCode(...new Uint8Array(header.buffer, header.byteOffset, 8)) !== "OpusHead"
              || header.getUint8(8) !== 1 || header.getUint8(9) !== 1 || header.getInt16(16, true) !== 0 || header.getUint8(18) !== 0) {
              throw new Error("The encoder returned an invalid Opus header.");
            }
            preSkip = header.getUint16(10, true);
          }
        } catch (error) {
          fail(error);
        }
      },
      error: fail,
    });
    encoder.configure(config);
  } catch (error) {
    fail(error);
    close();
    return null;
  }
  const activeEncoder = encoder;

  return {
    push(samples) {
      if (failed || samples.length === 0) return;
      let data: AudioData | undefined;
      try {
        data = new AudioData({
          format: "f32",
          sampleRate,
          numberOfFrames: samples.length,
          numberOfChannels: 1,
          timestamp: Math.round((pushedSamples / sampleRate) * 1_000_000),
          data: samples,
        });
        activeEncoder.encode(data);
        pushedSamples += samples.length;
      } catch (error) {
        fail(error);
      } finally {
        data?.close();
      }
    },
    async finish() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (failed || pushedSamples === 0) return null;
        await Promise.race([
          activeEncoder.flush(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("The Opus encoder did not finish.")), FLUSH_TIMEOUT_MS);
          }),
        ]);
        if (failed) return null;
        if (preSkip === null) throw new Error("The encoder did not report its delay.");
        const encodedSamples = packets.reduce((sum, packet) => sum + opusPacketSamples(packet), 0);
        const endSample = preSkip + pushedSamples;
        const lastPacketSamples = packets.length ? opusPacketSamples(packets[packets.length - 1]!) : 0;
        // Only the last frame's padding may differ; missing even part of the captured audio is a failure.
        if (encodedSamples < endSample || encodedSamples - endSample > lastPacketSamples) {
          throw new Error("The Opus encoding does not contain exactly the captured audio.");
        }
        return new Blob([muxOggOpus({ channels: 1, preSkip, inputSampleRate: sampleRate, packets, endSample })], { type: OPUS_RECORDING_MIME_TYPE });
      } catch (error) {
        fail(error);
        return null;
      } finally {
        clearTimeout(timer);
        close();
        packets.length = 0;
      }
    },
    cancel() {
      close();
      packets.length = 0;
    },
  };
}
