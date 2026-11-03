import type { ChatCompletionEntry } from "../api";
import type { ChatRenderBlock } from "./chat-activity";
import { readSelectedPlaybook, readVerificationRecord } from "./verification-record";
import type { CompletionStatus } from "../../shared/completion-report.js";
import { NO_PLAYBOOK } from "../../shared/workflow-vocabulary.js";

type RecordedVerification = { kind: "recorded"; status: CompletionStatus; toolCallId: string };

export interface AutopilotRunSummary {
  /** The turns the run took: the one you started and each it continued with on its own. */
  turns?: number;
  /** From the message that started the run to its completion, when both times are known. */
  durationMs?: number;
  verification?: RecordedVerification | { kind: "missing" };
}

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Pairs each completion with the autopilot run it ended. A run starts at a message sent with
 * Autopilot. The log does not record where a run stopped, so when another message came before the
 * completion (a steering note, or a new run after a stop) the start is uncertain: the completion is
 * still marked as Autopilot, without figures that could be wrong. A run whose start is not loaded,
 * or that an interactive message interrupted, is not marked.
 */
export function summarizeAutopilotRuns(blocks: ChatRenderBlock[]): Map<ChatCompletionEntry, AutopilotRunSummary> {
  const summaries = new Map<ChatCompletionEntry, AutopilotRunSummary>();
  let run: {
    startedAt?: number;
    continuations: number;
    uncertain: boolean;
    playbook?: string;
    report?: RecordedVerification;
  } | null = null;
  for (const block of blocks) {
    if (block.type === "message") {
      if (block.entry.role !== "user") continue;
      if (block.entry.agentMode !== "autopilot") {
        run = null;
      } else if (run) {
        run.uncertain = true;
      } else {
        run = { startedAt: time(block.entry.timestamp), continuations: 0, uncertain: false };
      }
      continue;
    }
    if (run && !run.uncertain && block.type === "activity") {
      for (const step of block.steps) {
        if (step.kind !== "tools") continue;
        for (const { toolCall } of step.entries) {
          const selected = readSelectedPlaybook(toolCall);
          if (selected !== undefined && selected !== run.playbook) {
            run.playbook = selected;
            run.report = undefined;
          }
        }
      }
    }
    if (run && !run.uncertain && block.type === "verification") {
      const report = readVerificationRecord(block.toolCall);
      const playbook = report?.playbook ?? run.playbook;
      if (report && playbook && playbook !== NO_PLAYBOOK && (!run.playbook || run.playbook === playbook)) {
        run.playbook = playbook;
        run.report = { kind: "recorded", status: report.status, toolCallId: block.toolCall.toolCallId };
      }
    }
    if (block.type === "continuation-segment") {
      if (run) run.continuations += block.count;
      continue;
    }
    if (block.type === "completion-segment") {
      if (!run) continue;
      const endedAt = time(block.entry.timestamp);
      summaries.set(block.entry, run.uncertain ? {} : {
        turns: run.continuations + 1,
        ...(run.playbook && run.playbook !== NO_PLAYBOOK ? { verification: run.report ?? { kind: "missing" } } : {}),
        ...(run.startedAt !== undefined && endedAt !== undefined && endedAt >= run.startedAt
          ? { durationMs: endedAt - run.startedAt }
          : {}),
      });
      run = null;
    }
  }
  return summaries;
}
