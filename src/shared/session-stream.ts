import { isRecord } from "./is-record.js";

export interface SessionHistoryCoverage {
  latestEventId?: string;
  latestTurnId?: string;
  latestTerminalEventId?: string;
}

export type RunNoticeKind = "stopped" | "interrupted" | "error" | "command";

export interface ProviderRetryState {
  phase: "waiting" | "retrying";
  retryAt: string;
}

export function normalizeProviderRetryState(value: unknown): ProviderRetryState | undefined {
  if (!isRecord(value) || (value.phase !== "waiting" && value.phase !== "retrying")
    || typeof value.retryAt !== "string" || !Number.isFinite(Date.parse(value.retryAt))) return undefined;
  return { phase: value.phase, retryAt: value.retryAt };
}

/**
 * A run outcome the bridge produced that `events.jsonl` does not represent — an error message, a
 * stopped/interrupted marker, or output from a slash command that never reached the SDK. Rendered
 * as a notice beneath the transcript so committed history stays disk-authoritative.
 */
export interface RunNotice {
  kind: RunNoticeKind;
  content?: string;
  message?: string;
  timestamp?: string;
  retryRunId?: string;
}

export interface SyntheticTerminalOverlay {
  type: "done" | "error" | "aborted" | "shutdown";
  runId: string;
  turnId?: string;
  turnInstanceId?: string;
  terminalSourceEventId?: string;
  timestamp?: string;
  notice?: RunNotice;
}
