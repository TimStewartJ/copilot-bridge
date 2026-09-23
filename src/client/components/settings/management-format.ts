import type { ManagementJobStatus, ManagementJobSummary, ManagementJobType } from "../../management-job-api";
import { isRecord } from "../../../shared/is-record.js";

/** Formatting shared by the System page's runtime and management-job sections. */

export function jobTypeLabel(type: ManagementJobType): string {
  switch (type) {
    case "self_update":
      return "Self update";
    case "staging_preview":
      return "Staging preview";
    case "staging_deploy":
      return "Staging deploy";
    default:
      return type;
  }
}

export function statusLabel(status: ManagementJobStatus): string {
  return status;
}

export function shortJobId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 10);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export function formatDurationMs(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatElapsed(start: string | undefined, end?: string): string {
  if (!start) return "—";
  const startTime = Date.parse(start);
  if (!Number.isFinite(startTime)) return "—";
  const endTime = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(endTime)) return "—";
  return formatDurationMs(Math.max(0, endTime - startTime));
}

export function heartbeatAgeMs(job: ManagementJobSummary, fetchedAt: string | undefined): number | undefined {
  if (typeof job.heartbeatAgeMs === "number" && Number.isFinite(job.heartbeatAgeMs)) {
    return Math.max(0, job.heartbeatAgeMs);
  }
  if (!job.heartbeatAt) return undefined;
  const heartbeatTime = Date.parse(job.heartbeatAt);
  const referenceTime = fetchedAt ? Date.parse(fetchedAt) : Date.now();
  if (!Number.isFinite(heartbeatTime) || !Number.isFinite(referenceTime)) return undefined;
  return Math.max(0, referenceTime - heartbeatTime);
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|api[-_]?key|private[-_]?key/i.test(key);
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? "[redacted]" : redactSensitive(item);
  }
  return redacted;
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(redactSensitive(value), null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatCapacityValue(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
