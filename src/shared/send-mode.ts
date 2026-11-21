import { isRecord } from "./is-record.js";

export const SEND_MODES = ["interactive", "autopilot"] as const;

export type AgentMode = (typeof SEND_MODES)[number];
export type CustomAutopilot = { kind: "custom-autopilot" } & (
  | { minMinutes: number; minAiCredits?: number }
  | { minMinutes?: number; minAiCredits: number }
);
export type SendMode = AgentMode | CustomAutopilot;

/** How far a Custom Autopilot run has got, for the chat's run line. */
export interface CustomAutopilotProgress {
  startedAt: string;
  /** Keep-going prompts sent so far. */
  continuations: number;
}

export const DEFAULT_SEND_MODE = "interactive" as const;
export const MIN_MINUTES = 10;
export const MAX_MINUTES = 24 * 60;
export const MIN_AI_CREDITS = 100;
export const MAX_AI_CREDITS = 100_000;
/** Custom Autopilot ends once the agent stops this many times in a row without using a tool. */
export const MAX_IDLE_PASSES = 5;
export const INVALID_SEND_MODE = "mode must be one of: interactive, autopilot, or custom-autopilot with valid minimums";

function validFloor(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

export function isCustomAutopilot(value: unknown): value is CustomAutopilot {
  return isRecord(value) && value.kind === "custom-autopilot"
    && Object.keys(value).every((key) => key === "kind" || key === "minMinutes" || key === "minAiCredits")
    && (value.minMinutes !== undefined || value.minAiCredits !== undefined)
    && (value.minMinutes === undefined || validFloor(value.minMinutes, MIN_MINUTES, MAX_MINUTES))
    && (value.minAiCredits === undefined || validFloor(value.minAiCredits, MIN_AI_CREDITS, MAX_AI_CREDITS));
}

export function isSendMode(value: unknown): value is SendMode {
  return value === "interactive" || value === "autopilot" || isCustomAutopilot(value);
}

export function isAutopilot(mode: SendMode | undefined): boolean {
  return mode === "autopilot" || typeof mode === "object";
}

/** Only text transports need a codec; the original two modes keep their wire values. */
export function encodeSendMode(mode: SendMode): string {
  if (typeof mode === "string") return mode;
  return JSON.stringify({ kind: mode.kind, minMinutes: mode.minMinutes, minAiCredits: mode.minAiCredits });
}

export function decodeSendMode(value: string | null): SendMode | undefined {
  if (value === "interactive" || value === "autopilot") return value;
  if (!value?.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isCustomAutopilot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a CLI agent mode; plan and shell count as interactive, anything else is undefined. */
export function toSendMode(value: unknown): AgentMode | undefined {
  if (value === "autopilot") return "autopilot";
  if (value === "interactive" || value === "plan" || value === "shell") return "interactive";
  return undefined;
}
