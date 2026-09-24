import type { ChatReasoningEntry, ChatToolEntry, ToolCall } from "../api";
import type { ChatRenderSegment } from "./tool-call-tree";
import { getToolCallStatus } from "./tool-call-status";
import { isSettledAskUserCall } from "./ask-user-record";

/**
 * Work the agent did between two things it said: its thinking and its tool calls, in order. The
 * chat renders each run of it as one collapsible block, so a long agentic turn reads as a few lines
 * of prose instead of a wall of tool rows.
 */

export type ActivityStep =
  | { kind: "reasoning"; key: string; entry: ChatReasoningEntry }
  | {
      kind: "tools";
      key: string;
      entries: ChatToolEntry[];
      turnId?: string;
      turnInstanceId?: string;
    };

export interface ActivityBlock {
  type: "activity";
  /** Stable across the live-to-disk handoff, so an expanded block stays expanded. */
  key: string;
  steps: ActivityStep[];
}

/** A question the agent asked, lifted out of its steps so the exchange reads as conversation. */
export interface QuestionBlock {
  type: "question";
  key: string;
  toolCall: ToolCall;
}

export type ChatRenderBlock =
  | ActivityBlock
  | QuestionBlock
  | Exclude<ChatRenderSegment, { type: "tool-segment" } | { type: "reasoning-segment" }>;

export interface GroupActivityOptions {
  /**
   * Also lift out questions with no recorded answer. Only safe once nothing can still answer them;
   * while a run is live the open question is shown by its own form.
   */
  includeUnfinishedQuestions?: boolean;
}

export interface ActivitySummary {
  toolCount: number;
  thoughtCount: number;
  runningCount: number;
  failedCount: number;
  streamingThought: boolean;
  /** Wall-clock span of the block, when its steps carry enough timestamps to know it. */
  durationMs?: number;
  startedAtMs?: number;
}

function reasoningStepKey(entry: ChatReasoningEntry, index: number): string {
  return `reasoning:${entry.reasoning.messageEventId ?? entry.id ?? index}`;
}

function toolStepKey(entries: ChatToolEntry[], index: number): string {
  return `tools:${entries[0]?.toolCall.toolCallId ?? index}`;
}

/**
 * A turn instance id is the persisted `assistant.turn_start` event id, identical live and on disk.
 * Keying a block by the turn that opened it keeps it mounted while its entries are handed from the
 * stream to disk history; entry ids and tool-call ids are only the fallback for older logs.
 */
function getBlockBaseKey(step: ActivityStep): string {
  if (step.kind === "reasoning") {
    return step.entry.turnInstanceId
      ?? step.entry.turnId
      ?? step.entry.reasoning.messageEventId
      ?? step.entry.id
      ?? step.key;
  }
  return step.turnInstanceId
    ?? step.entries[0]?.turnInstanceId
    ?? step.turnId
    ?? step.entries[0]?.toolCall.toolCallId
    ?? step.key;
}

export function groupActivitySegments(
  segments: ChatRenderSegment[],
  options: GroupActivityOptions = {},
): ChatRenderBlock[] {
  const blocks: ChatRenderBlock[] = [];
  const keyCounts = new Map<string, number>();
  let steps: ActivityStep[] = [];

  // A call can appear more than once (a start row and a later snapshot); the fullest copy decides.
  const latestToolCalls = new Map<string, ToolCall>();
  for (const segment of segments) {
    if (segment.type !== "tool-segment") continue;
    for (const { toolCall } of segment.entries) {
      const known = latestToolCalls.get(toolCall.toolCallId);
      if (!known || getToolCallStatus(known) === "running") latestToolCalls.set(toolCall.toolCallId, toolCall);
    }
  }
  const questionIds = new Set(
    [...latestToolCalls.values()]
      .filter((toolCall) => isSettledAskUserCall(toolCall, options.includeUnfinishedQuestions === true))
      .map((toolCall) => toolCall.toolCallId),
  );
  const emittedQuestionIds = new Set<string>();

  const pushTools = (
    entries: ChatToolEntry[],
    index: number,
    segment: Extract<ChatRenderSegment, { type: "tool-segment" }>,
  ) => {
    if (entries.length === 0) return;
    steps.push({
      kind: "tools",
      key: toolStepKey(entries, index),
      entries,
      ...(segment.turnId ? { turnId: segment.turnId } : {}),
      ...(segment.turnInstanceId ? { turnInstanceId: segment.turnInstanceId } : {}),
    });
  };

  const flush = () => {
    if (steps.length === 0) return;
    const baseKey = getBlockBaseKey(steps[0]!);
    // One turn can open several blocks (thinking, then text, then tools), so number them.
    const occurrence = keyCounts.get(baseKey) ?? 0;
    keyCounts.set(baseKey, occurrence + 1);
    blocks.push({ type: "activity", key: `activity:${baseKey}:${occurrence}`, steps });
    steps = [];
  };

  segments.forEach((segment, index) => {
    if (segment.type === "reasoning-segment") {
      steps.push({ kind: "reasoning", key: reasoningStepKey(segment.entry, index), entry: segment.entry });
      return;
    }
    if (segment.type === "tool-segment") {
      if (segment.entries.length === 0) return;
      if (questionIds.size === 0) {
        pushTools(segment.entries, index, segment);
        return;
      }
      let pending: ChatToolEntry[] = [];
      for (const entry of segment.entries) {
        const id = entry.toolCall.toolCallId;
        if (!questionIds.has(id)) {
          pending.push(entry);
          continue;
        }
        if (emittedQuestionIds.has(id)) continue;
        emittedQuestionIds.add(id);
        pushTools(pending, index, segment);
        pending = [];
        flush();
        blocks.push({ type: "question", key: `question:${id}`, toolCall: latestToolCalls.get(id) ?? entry.toolCall });
      }
      pushTools(pending, index, segment);
      return;
    }
    flush();
    blocks.push(segment);
  });
  flush();
  return blocks;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function summarizeActivity(steps: ActivityStep[], nowMs?: number): ActivitySummary {
  let toolCount = 0;
  let thoughtCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  let streamingThought = false;
  let startedAtMs: number | undefined;
  let endedAtMs: number | undefined;
  const seenToolCallIds = new Set<string>();

  const observe = (start: number | undefined, end: number | undefined) => {
    if (start !== undefined) startedAtMs = startedAtMs === undefined ? start : Math.min(startedAtMs, start);
    const last = end ?? start;
    if (last !== undefined) endedAtMs = endedAtMs === undefined ? last : Math.max(endedAtMs, last);
  };

  for (const step of steps) {
    if (step.kind === "reasoning") {
      thoughtCount += 1;
      if (step.entry.reasoning.streaming) streamingThought = true;
      // A model call's end also covers the reply it wrote, so only its start counts as work here.
      const at = parseTime(step.entry.reasoning.startedAt) ?? parseTime(step.entry.timestamp);
      observe(at, at);
      continue;
    }
    for (const entry of step.entries) {
      const { toolCall } = entry;
      // The same call can appear twice in a turn group (a start row and a later snapshot).
      if (seenToolCallIds.has(toolCall.toolCallId)) continue;
      seenToolCallIds.add(toolCall.toolCallId);
      toolCount += 1;
      const status = getToolCallStatus(toolCall);
      if (status === "running") runningCount += 1;
      if (status === "failed") failedCount += 1;
      observe(parseTime(toolCall.startedAt), parseTime(toolCall.completedAt));
    }
  }

  const live = runningCount > 0 || streamingThought;
  const end = live && nowMs !== undefined ? nowMs : endedAtMs;
  const durationMs = startedAtMs !== undefined && end !== undefined && end >= startedAtMs
    ? end - startedAtMs
    : undefined;
  return {
    toolCount,
    thoughtCount,
    runningCount,
    failedCount,
    streamingThought,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
}

const MARKDOWN_NOISE = /[*_`#>]+/g;

/** One plain line that stands in for a block of thinking: its first heading or sentence. */
export function getReasoningHeadline(content: string, maxLength = 96): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^(\*\*[^*]+\*\*|#{1,6}\s+.+)$/.test(line));
  const source = (heading ?? lines[0] ?? "").replace(MARKDOWN_NOISE, "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const sentenceEnd = source.search(/[.!?](\s|$)/);
  const sentence = sentenceEnd > 12 ? source.slice(0, sentenceEnd + 1) : source;
  if (sentence.length <= maxLength) return sentence;
  const cut = sentence.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The newest stretch of streaming thinking, flattened so it can run along one line. */
export function getReasoningTail(content: string, maxLength = 320): string {
  const flat = content.replace(MARKDOWN_NOISE, "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  const tail = flat.slice(flat.length - maxLength);
  const firstSpace = tail.indexOf(" ");
  return firstSpace >= 0 && firstSpace < 24 ? tail.slice(firstSpace + 1) : tail;
}
