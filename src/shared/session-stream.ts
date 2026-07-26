import type { TerminalCompletion } from "./terminal-completion.js";

export interface SessionHistoryCoverage {
  latestEventId?: string;
  latestTurnId?: string;
  latestTerminalEventId?: string;
}

export interface ProjectedAssistantEntry {
  id: string;
  content: string;
  turnId?: string;
  turnInstanceId?: string;
  sourceEventId?: string;
  timestamp?: string;
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
  /** @deprecated Pre-notice overlay shape; ignored when reading. */
  terminalCompletion?: TerminalCompletion;
  /** @deprecated Pre-notice overlay shape; ignored when reading. */
  finalAssistantEntry?: ProjectedAssistantEntry;
}
