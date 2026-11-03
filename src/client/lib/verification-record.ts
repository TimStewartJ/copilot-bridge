import type { ToolCall } from "../api";
import {
  COMPLETION_TOOL_NAME,
  deriveCompletionStatus,
  isCompletionStatus,
  readCompletionInput,
  type CompletionEvidence,
  type CompletionStatus,
} from "../../shared/completion-report.js";

/** What the verified card shows for one `verify_complete` call. */
export interface VerificationRecord {
  status: CompletionStatus;
  summary: string;
  playbookLabel?: string;
  evidence: CompletionEvidence[];
  unverified: string[];
  notes: string[];
}

export function isCompletionToolName(name: string): boolean {
  return name.trim().replace(/^bridge-tools-(?:session-)?/i, "").toLowerCase() === COMPLETION_TOOL_NAME;
}

function readResult(result: string | undefined): Record<string, unknown> | undefined {
  const text = result?.trim();
  if (!text?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The card for a recorded `verify_complete` call: the evidence from its arguments, the status and
 * playbook label from its result. A rejected or unfinished call has no card.
 */
export function readVerificationRecord(toolCall: Pick<ToolCall, "name" | "args" | "result" | "success">): VerificationRecord | null {
  if (!isCompletionToolName(toolCall.name) || toolCall.success === false) return null;
  const result = readResult(toolCall.result);
  // The result is the tool's JSON; when it cannot be read, a successful call still recorded the arguments.
  if (result ? result.success !== true : toolCall.success !== true) return null;
  const input = readCompletionInput(toolCall.args);
  if (!input.ok) return null;
  const { summary, evidence, unverified, notes } = input.value;
  const label = typeof result?.playbookLabel === "string" && result.playbookLabel.trim()
    ? result.playbookLabel
    : typeof result?.playbook === "string" && result.playbook.trim() ? result.playbook : undefined;
  const reported = result?.status;
  return {
    status: isCompletionStatus(reported) ? reported : deriveCompletionStatus(evidence, unverified),
    summary,
    ...(label ? { playbookLabel: label } : {}),
    evidence,
    unverified,
    notes,
  };
}

/** A root-level `verify_complete` call that recorded a report, so it reads as a card, not a step. */
export function isRecordedCompletionCall(toolCall: ToolCall): boolean {
  if (toolCall.parentToolCallId || toolCall.isSubAgent) return false;
  return readVerificationRecord(toolCall) !== null;
}
