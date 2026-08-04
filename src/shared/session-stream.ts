export interface SessionHistoryCoverage {
  latestEventId?: string;
  latestTurnId?: string;
  latestTerminalEventId?: string;
}

export type RunNoticeKind = "stopped" | "interrupted" | "error" | "command";

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
