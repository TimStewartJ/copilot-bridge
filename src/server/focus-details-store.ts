import { createHash } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import { isRecord } from "../shared/is-record.js";
import { FeedCardValidationError, type FeedCardMutationInput, type FeedCardStatus } from "./feed-store.js";

export const FOCUS_LIFECYCLES = ["active", "acknowledged", "handed_off", "resolved", "accepted_risk", "dismissed"] as const;
export type FocusLifecycle = typeof FOCUS_LIFECYCLES[number];
export type FocusActor = "agent" | "user" | "legacy" | "system";
export type FocusNotificationMode = "focus" | "summary" | "immediate";
export type FocusEvidence = string | { summary: string; url?: string; observedAt?: string };

export interface FocusObjectDetails {
  objectId: string;
  lifecycle: FocusLifecycle;
  sourceFamily: string | null;
  producer: string | null;
  observedAt: string | null;
  validUntil: string | null;
  interventionBy: string | null;
  evidence: FocusEvidence[];
  impact: string | null;
  consequenceOfDelay: string | null;
  alternatives: string[];
  recommendation: string | null;
  fallback: string | null;
  outcome: string | null;
  resolutionReason: string | null;
  notificationMode: FocusNotificationMode;
  authorizationGrantId: string | null;
  episodeReason: string | null;
  contentFingerprint: string;
  lastMeaningfulChangeAt: string;
  acknowledgedAt: string | null;
  handedOffAt: string | null;
  resolvedAt: string | null;
  originalTaskId: string | null;
  originalTaskTitle: string | null;
  orphanedAt: string | null;
}

export const FOCUS_DETAIL_FIELDS = [
  "lifecycle", "sourceFamily", "producer", "observedAt", "validUntil", "interventionBy",
  "evidence", "impact", "consequenceOfDelay", "alternatives", "recommendation", "fallback",
  "outcome", "resolutionReason", "notificationMode", "authorizationGrantId", "episodeReason",
] as const;
export type FocusDetailUpdates = Partial<Pick<FocusObjectDetails, typeof FOCUS_DETAIL_FIELDS[number]>>;
export type FocusMutationInput = FeedCardMutationInput
  & Partial<Record<typeof FOCUS_DETAIL_FIELDS[number], unknown>>
  & { question?: unknown; lifecycleReason?: unknown; newEpisode?: unknown; expectedActivationId?: unknown; recurring?: unknown };

export function focusRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new FeedCardValidationError("Input must be an object");
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new FeedCardValidationError(`Unknown field(s): ${unknown.join(", ")}`);
  return value;
}

export function focusText(value: unknown, field: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new FeedCardValidationError(`${field} must be a non-empty string${nullable ? " or null" : ""}`);
  }
  if (Buffer.byteLength(value, "utf8") > 16_384) throw new FeedCardValidationError(`${field} is too long`);
  return value.trim();
}

export function focusTimestamp(value: unknown, field: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new FeedCardValidationError(`${field} must be an ISO timestamp with timezone${nullable ? " or null" : ""}`);
  }
  return new Date(value).toISOString();
}

export function focusEnum<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new FeedCardValidationError(`${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

export function focusBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new FeedCardValidationError(`${field} must be boolean`);
  return value;
}

export function focusInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new FeedCardValidationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function focusStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new FeedCardValidationError(`${field} must be an array of at most 100 strings`);
  return value.map((entry) => focusText(entry, field)!);
}

export function focusEvidence(value: unknown): FocusEvidence[] {
  if (!Array.isArray(value) || value.length > 100) throw new FeedCardValidationError("evidence must be an array of at most 100 observations");
  return value.map((entry): FocusEvidence => {
    if (typeof entry === "string") return focusText(entry, "evidence")!;
    const record = focusRecord(entry, ["summary", "url", "observedAt"]);
    const evidence: Exclude<FocusEvidence, string> = { summary: focusText(record.summary, "evidence.summary")! };
    if (record.url !== undefined) {
      const url = focusText(record.url, "evidence.url")!;
      if (!/^https?:\/\//i.test(url)) throw new FeedCardValidationError("evidence.url must be an http(s) URL");
      evidence.url = url;
    }
    if (record.observedAt !== undefined) evidence.observedAt = focusTimestamp(record.observedAt, "evidence.observedAt")!;
    return evidence;
  });
}

export function normalizeFocusDetailUpdates(input: FocusMutationInput): FocusDetailUpdates {
  const updates: FocusDetailUpdates = {};
  for (const key of FOCUS_DETAIL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    switch (key) {
      case "lifecycle": updates.lifecycle = focusEnum(value, key, FOCUS_LIFECYCLES); break;
      case "notificationMode": updates.notificationMode = focusEnum(value, key, ["focus", "summary", "immediate"] as const); break;
      case "evidence": updates.evidence = focusEvidence(value); break;
      case "alternatives": updates.alternatives = focusStrings(value, key); break;
      case "observedAt":
      case "validUntil":
      case "interventionBy": updates[key] = focusTimestamp(value, key, true); break;
      default: updates[key] = focusText(value, key, true);
    }
  }
  return updates;
}

export function lifecycleToLegacyStatus(lifecycle: FocusLifecycle): FeedCardStatus {
  if (lifecycle === "dismissed") return "dismissed";
  if (lifecycle === "resolved" || lifecycle === "accepted_risk") return "done";
  return "active";
}

export function legacyStatusToLifecycle(status: FeedCardStatus): FocusLifecycle {
  return status === "done" ? "resolved" : status;
}

export function isAttentionLifecycle(lifecycle: FocusLifecycle): boolean {
  return lifecycle === "active" || lifecycle === "acknowledged";
}

export function isOpenLifecycle(lifecycle: FocusLifecycle): boolean {
  return isAttentionLifecycle(lifecycle) || lifecycle === "handed_off";
}

export function defaultFocusDetails(objectId: string, now: string): FocusObjectDetails {
  return {
    objectId, lifecycle: "active", sourceFamily: null, producer: null, observedAt: null,
    validUntil: null, interventionBy: null, evidence: [], impact: null, consequenceOfDelay: null,
    alternatives: [], recommendation: null, fallback: null, outcome: null, resolutionReason: null,
    notificationMode: "focus", authorizationGrantId: null, episodeReason: null, contentFingerprint: "",
    lastMeaningfulChangeAt: now, acknowledgedAt: null, handedOffAt: null, resolvedAt: null,
    originalTaskId: null, originalTaskTitle: null, orphanedAt: null,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function focusFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

type DetailsRow = Omit<FocusObjectDetails, "evidence" | "alternatives"> & { evidenceJson: string; alternativesJson: string };

export function hydrateFocusDetails(row: DetailsRow): FocusObjectDetails {
  const { evidenceJson, alternativesJson, ...rest } = row;
  return {
    ...rest,
    lifecycle: focusEnum(row.lifecycle, "stored lifecycle", FOCUS_LIFECYCLES),
    notificationMode: focusEnum(row.notificationMode, "stored notificationMode", ["focus", "summary", "immediate"]),
    evidence: focusEvidence(JSON.parse(evidenceJson)),
    alternatives: focusStrings(JSON.parse(alternativesJson), "stored alternatives"),
  };
}

export function createFocusDetailsStore(db: DatabaseSync) {
  function get(objectId: string): FocusObjectDetails | undefined {
    const row = db.prepare("SELECT * FROM focus_object_details WHERE objectId = ?").get(objectId);
    return row ? hydrateFocusDetails(row as DetailsRow) : undefined;
  }

  function save(details: FocusObjectDetails): void {
    const { evidence, alternatives, ...scalar } = details;
    const row = { ...scalar, evidenceJson: JSON.stringify(evidence), alternativesJson: JSON.stringify(alternatives) };
    const keys = Object.keys(row);
    db.prepare(`
      INSERT INTO focus_object_details (${keys.join(",")})
      VALUES (${keys.map(() => "?").join(",")})
      ON CONFLICT(objectId) DO UPDATE SET ${keys.filter((key) => key !== "objectId").map((key) => `${key}=excluded.${key}`).join(",")}
    `).run(...Object.values(row));
  }
  function refreshObservation(objectId: string, observedAt: string | null, validUntil: string | null, contentFingerprint: string): void {
    const updated = db.prepare(`UPDATE focus_object_details
      SET observedAt=?, validUntil=?, contentFingerprint=? WHERE objectId=?`)
      .run(observedAt, validUntil, contentFingerprint, objectId);
    if (!updated.changes) throw new Error(`Focus details missing for observation refresh ${objectId}`);
  }
  return { get, save, refreshObservation };
}

export type FocusDetailsStore = ReturnType<typeof createFocusDetailsStore>;
