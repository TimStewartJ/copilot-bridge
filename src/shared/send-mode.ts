export const SEND_MODES = ["interactive", "autopilot"] as const;

export type SendMode = (typeof SEND_MODES)[number];

export const DEFAULT_SEND_MODE: SendMode = "interactive";

export function isSendMode(value: unknown): value is SendMode {
  return value === "interactive" || value === "autopilot";
}
