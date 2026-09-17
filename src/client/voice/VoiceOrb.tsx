import { useEffect, useRef } from "react";
import type { VoiceState } from "./voice-api";

interface OrbTheme {
  hue: number;
  breath: number;
  wobble: number;
  alpha: number;
}

const THEMES: Record<VoiceState | "idle", OrbTheme> = {
  idle: { hue: 222, breath: 0.7, wobble: 0.15, alpha: 0.55 },
  starting: { hue: 205, breath: 1.6, wobble: 0.3, alpha: 0.75 },
  listening: { hue: 192, breath: 1.1, wobble: 0.25, alpha: 0.92 },
  hearing: { hue: 172, breath: 1.8, wobble: 0.55, alpha: 1 },
  endpointing: { hue: 42, breath: 2.4, wobble: 0.35, alpha: 1 },
  thinking: { hue: 272, breath: 2.2, wobble: 0.45, alpha: 1 },
  speaking: { hue: 318, breath: 1.4, wobble: 0.65, alpha: 1 },
  asleep: { hue: 232, breath: 0.45, wobble: 0.08, alpha: 0.35 },
  ended: { hue: 222, breath: 0.5, wobble: 0.1, alpha: 0.35 },
};

export interface VoiceOrbProps {
  state: VoiceState | "idle";
  turnProbability: number;
  getMicLevel(): number;
  getOutputLevel(): number;
}

export function VoiceOrb({ state, turnProbability, getMicLevel, getOutputLevel }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ state, turnProbability, getMicLevel, getOutputLevel });
  propsRef.current = { state, turnProbability, getMicLevel, getOutputLevel };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof requestAnimationFrame !== "function") return;
    let frame = 0;
    let hue = THEMES.idle.hue;
    let alpha = THEMES.idle.alpha;
    let level = 0;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const draw = (timestamp: number) => {
      frame = requestAnimationFrame(draw);
      const { state: current, turnProbability: probability, getMicLevel: mic, getOutputLevel: output } = propsRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const theme = THEMES[current] ?? THEMES.idle;
      const target = current === "speaking"
        ? output() * 5
        : current === "listening" || current === "hearing" || current === "endpointing"
          ? mic() * 7
          : 0;
      level += (Math.min(1, target) - level) * 0.22;
      hue += (theme.hue - hue) * 0.06;
      alpha += (theme.alpha - alpha) * 0.05;
      const t = reducedMotion ? 0 : timestamp / 1000;
      const cx = width / 2;
      const cy = height / 2;
      const base = Math.min(width, height) * 0.24;
      const radius = base * (1 + Math.sin(t * theme.breath) * 0.035 + level * 0.36);

      const glow = context.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius * 2.5);
      glow.addColorStop(0, `hsla(${hue}, 95%, 62%, ${0.3 * alpha})`);
      glow.addColorStop(1, "hsla(0, 0%, 0%, 0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(cx, cy, radius * 2.5, 0, Math.PI * 2);
      context.fill();

      for (let layer = 0; layer < 3; layer++) {
        context.beginPath();
        const points = 140;
        const amplitude = theme.wobble + level * 0.9;
        for (let i = 0; i <= points; i++) {
          const angle = (i / points) * Math.PI * 2;
          const wobble = Math.sin(angle * 3 + t * (1.1 + layer * 0.5)) * 0.045
            + Math.sin(angle * 5 - t * (0.7 + layer * 0.35)) * 0.03
            + Math.sin(angle * 8 + t * 2.3) * 0.012 * level;
          const r = radius * (1 - layer * 0.14) * (1 + wobble * amplitude * 1.6);
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          if (i === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        const gradient = context.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.05, cx, cy, radius * 1.15);
        gradient.addColorStop(0, `hsla(${hue + 35}, 100%, 88%, ${(0.85 - layer * 0.2) * alpha})`);
        gradient.addColorStop(0.5, `hsla(${hue}, 92%, 58%, ${(0.6 - layer * 0.12) * alpha})`);
        gradient.addColorStop(1, `hsla(${hue - 45}, 90%, 28%, ${0.08 * alpha})`);
        context.fillStyle = gradient;
        context.fill();
      }

      if (current === "thinking") {
        for (let i = 0; i < 9; i++) {
          const angle = t * 2.4 + (i * Math.PI * 2) / 9;
          const r = radius * (1.38 + Math.sin(t * 3 + i) * 0.04);
          context.fillStyle = `hsla(${hue + i * 12}, 100%, 78%, ${0.25 + (0.75 * (i + 1)) / 9})`;
          context.beginPath();
          context.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 2.2 + i * 0.35, 0, Math.PI * 2);
          context.fill();
        }
      }
      if (current === "endpointing") {
        context.strokeStyle = `hsla(${hue}, 100%, 72%, 0.85)`;
        context.lineWidth = 3;
        context.lineCap = "round";
        context.beginPath();
        context.arc(cx, cy, radius * 1.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.04, probability));
        context.stroke();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />;
}
