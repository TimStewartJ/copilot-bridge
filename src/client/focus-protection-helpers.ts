import type { FocusProtectionRequest } from "./api";
import { MAX_FOCUS_PROTECTION_DURATION_MS } from "../shared/focus-protection.js";

export type ProtectionDuration = "30" | "60" | "90" | "custom-duration" | "custom-end";
export interface FocusProtectionForm {
  reason: string;
  start: "now" | "scheduled";
  startsAtLocal: string;
  duration: ProtectionDuration;
  customMinutes: string;
  endsAtLocal: string;
  allowNeedsInput: boolean;
  allowAuthorizedDeadlineOverride: boolean;
}

export function buildFocusProtectionRequest(form: FocusProtectionForm, nowMs: number, timezone: string): FocusProtectionRequest {
  const reason = form.reason.trim();
  if (!reason) throw new Error("Enter a reason for protecting focus.");
  const startsAt = form.start === "scheduled" ? Date.parse(form.startsAtLocal) : nowMs;
  if (!Number.isFinite(startsAt) || (form.start === "scheduled" && startsAt <= nowMs)) {
    throw new Error("Choose a valid future start time.");
  }
  const minutes = Number(form.duration === "custom-duration" ? form.customMinutes : form.duration);
  const endsAt = form.duration === "custom-end" ? Date.parse(form.endsAtLocal) : startsAt + minutes * 60_000;
  if (!Number.isFinite(endsAt) || endsAt <= startsAt) throw new Error("Choose an end after the start, or a positive duration.");
  if (endsAt - startsAt > MAX_FOCUS_PROTECTION_DURATION_MS) throw new Error("Protection can last at most 7 days.");
  return {
    ...(form.start === "scheduled" ? { startsAt: new Date(startsAt).toISOString() } : {}),
    endsAt: new Date(endsAt).toISOString(),
    timezone,
    reason,
    allowNeedsInput: form.allowNeedsInput,
    allowAuthorizedDeadlineOverride: form.allowAuthorizedDeadlineOverride,
  };
}

export function protectionTime(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short", timeZone: timezone,
    }).format(new Date(value));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return `Unknown time (${value})`;
  }
}

export function protectionCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}
