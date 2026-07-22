import type { TerminalCompletion } from "./terminal-completion.js";

export interface SessionHistoryCoverage {
  latestEventId?: string;
  latestTurnId?: string;
  latestTerminalEventId?: string;
}

export interface SyntheticTerminalOverlay {
  type: "done" | "error" | "aborted" | "shutdown";
  runId: string;
  turnId?: string;
  assistantSourceEventId?: string;
  content?: string;
  message?: string;
  timestamp?: string;
  terminalCompletion?: TerminalCompletion;
}
