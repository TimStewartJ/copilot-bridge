export const SEND_MODES = ["interactive", "autopilot"] as const;

export type SendMode = (typeof SEND_MODES)[number];

export const DEFAULT_SEND_MODE: SendMode = "interactive";

export function isSendMode(value: unknown): value is SendMode {
  return value === "interactive" || value === "autopilot";
}

/** Reads a CLI agent mode; plan and shell count as interactive, anything else is undefined. */
export function toSendMode(value: unknown): SendMode | undefined {
  if (value === "autopilot") return "autopilot";
  if (value === "interactive" || value === "plan" || value === "shell") return "interactive";
  return undefined;
}
