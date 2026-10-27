import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion";

const BAR_WIDTH = 3;
const BAR_STEP = 6;
/** A new bar enters from the right this often, so the line drifts left at about 65 px a second. */
const BAR_INTERVAL_MS = 90;
const SILENT_ALPHA = 0.3;
/** Microphone loudness in dBFS mapped onto bar height: the noise floor reads as a flat line, speech fills it. */
const FLOOR_DB = -56;
const CEILING_DB = -14;

export interface VoiceRecordingWaveProps {
  /** Microphone loudness as RMS, 0 to 1; read once per animation frame. */
  getLevel(): number;
  /** False while the microphone is starting or the recording is being finished: the line holds still. */
  live: boolean;
}

/** Bar height for a loudness, 0 (silence, a dot) to 1 (loud speech). */
export function levelToHeight(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const linear = Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
  return linear ** 1.6;
}

/** The composer's recording line: a dotted line across the box that bounces with what the microphone hears. */
export function VoiceRecordingWave({ getLevel, live }: VoiceRecordingWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ getLevel, live });
  propsRef.current = { getLevel, live };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof requestAnimationFrame !== "function") return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const history: number[] = [];
    let frame = 0;
    let smoothed = 0;
    let peak = 0;
    let lastPush = performance.now();
    let color = "";
    let colorReadAt = -Infinity;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const { getLevel: readLevel, live: isLive } = propsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        colorReadAt = -Infinity;
      }
      // The theme can change under a long recording, so the colour is re-read now and then.
      if (now - colorReadAt > 1_000) {
        color = getComputedStyle(canvas).color;
        colorReadAt = now;
      }

      const target = isLive ? levelToHeight(readLevel()) : 0;
      smoothed += (target - smoothed) * (target > smoothed ? 0.55 : 0.18);
      peak = Math.max(peak, smoothed);
      const reduced = prefersReducedMotion();
      const capacity = Math.ceil(width / BAR_STEP) + 1;

      if (isLive && !reduced) {
        while (now - lastPush >= BAR_INTERVAL_MS) {
          history.push(peak);
          peak = smoothed;
          lastPush += BAR_INTERVAL_MS;
        }
        if (history.length > capacity) history.splice(0, history.length - capacity);
      } else {
        lastPush = now;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      const middle = height / 2;
      const tallest = height - 2;
      const offset = isLive && !reduced ? ((now - lastPush) / BAR_INTERVAL_MS) * BAR_STEP : 0;
      const fadeWidth = Math.min(48, width * 0.2);

      for (let index = 0; index < capacity; index++) {
        const x = width - BAR_WIDTH - index * BAR_STEP - offset;
        if (x < -BAR_WIDTH) break;
        // Reduced motion: the line stays put and swells in place with the current loudness.
        const value = reduced
          ? smoothed * (0.55 + 0.45 * Math.cos(((index / capacity) - 0.5) * Math.PI))
          : history[history.length - 1 - index] ?? 0;
        const barHeight = BAR_WIDTH + value * (tallest - BAR_WIDTH);
        const edgeFade = Math.min(1, Math.max(0, x / fadeWidth));
        context.globalAlpha = (SILENT_ALPHA + (1 - SILENT_ALPHA) * Math.min(1, value * 4)) * edgeFade;
        context.beginPath();
        if (typeof context.roundRect === "function") {
          context.roundRect(x, middle - barHeight / 2, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
        } else {
          context.rect(x, middle - barHeight / 2, BAR_WIDTH, barHeight);
        }
        context.fill();
      }
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full text-text-primary" aria-hidden="true" />;
}
