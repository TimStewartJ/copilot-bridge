export const SEND_MODES = ["interactive", "autopilot"] as const;

export type SendMode = (typeof SEND_MODES)[number];

export const DEFAULT_SEND_MODE: SendMode = "interactive";

export function isSendMode(value: unknown): value is SendMode {
  return value === "interactive" || value === "autopilot";
}

/**
 * Reads a Copilot CLI agent mode as a send mode. Plan and shell modes are not autopilot, so they
 * count as interactive; anything unrecognised is unknown.
 */
export function toSendMode(value: unknown): SendMode | undefined {
  if (value === "autopilot") return "autopilot";
  if (value === "interactive" || value === "plan" || value === "shell") return "interactive";
  return undefined;
}
