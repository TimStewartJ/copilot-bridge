import type { ChatReasoningEntry, ChatToolEntry, ToolCall } from "../api";
import type { TranscriptAgentDirectory } from "../../shared/transcript-agents.js";
import type { ChatRenderSegment } from "./tool-call-tree";
import { getOwnToolCallStatus, getToolCallStatus, type ToolCallStatus } from "./tool-call-status";
import { isSettledAskUserCall } from "./ask-user-record";

/**
 * Work done between two things the agent said: its thinking and its tool calls, in order, and what
 * each sub-agent did meanwhile. The chat renders each such stretch as one collapsible block, so a
 * long agentic turn reads as a few lines of prose instead of a wall of tool rows.
 */

export type ActivityStep =
  | { kind: "reasoning"; key: string; entry: ChatReasoningEntry }
  | {
      /** The main agent's calls of one turn. A delegation among them holds what its agent did here. */
      kind: "tools";
      key: string;
      entries: ChatToolEntry[];
      turnId?: string;
      turnInstanceId?: string;
    }
  | {
      /**
       * What one agent did in this stretch when it was launched in an earlier one. However its
       * calls were interleaved with everyone else's, they are one step, and so one row.
       */
      kind: "agent";
      key: string;
      /** The call that launched the agent the main agent delegated to. */
      agentToolCallId: string;
      entries: ChatToolEntry[];
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
  /**
   * The session's agents, for following a step up to the agent the main agent launched when the
   * launching calls in between are above the loaded history.
   */
  agents?: Pick<TranscriptAgentDirectory, "byToolCallId">;
}

export interface ActivitySummary {
  /** The main agent's own calls. Handing work to an agent is one of them. */
  toolCount: number;
  thoughtCount: number;
  /** Calls still going in this stretch, the main agent's or an agent's. */
  runningCount: number;
  /** The main agent's calls that failed. */
  failedCount: number;
  /** Agents that did something in this stretch, with how much they did and how much of it failed. */
  agentCount: number;
  agentToolCount: number;
  agentFailedCount: number;
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
 * stream to disk history; entry ids and tool-call ids are only the fallback for older logs. A block
 * that opens with an agent's step is keyed by that call: the agent's turn is not known to the
 * stream, and one agent opens many blocks.
 */
function getBlockBaseKey(step: ActivityStep): string {
  if (step.kind === "reasoning") {
    return step.entry.turnInstanceId
      ?? step.entry.turnId
      ?? step.entry.reasoning.messageEventId
      ?? step.entry.id
      ?? step.key;
  }
  if (step.kind === "agent") return step.entries[0]?.toolCall.toolCallId ?? step.key;
  return step.turnInstanceId
    ?? step.entries[0]?.turnInstanceId
    ?? step.turnId
    ?? step.entries[0]?.toolCall.toolCallId
    ?? step.key;
}

/**
 * Puts each agent's calls in one place within a stretch. A call made by an agent that was
 * delegated to in this stretch moves into the step that holds the delegation, where it renders
 * beneath it. A call made by an agent launched earlier joins that agent's one step, which sits
 * where the agent first acted here. The main agent's steps keep their order.
 */
function gatherAgentSteps(
  steps: ActivityStep[],
  topLevelAgentOf: (toolCall: ToolCall) => string,
): ActivityStep[] {
  const mainCallIds = new Set<string>();
  let hasAgentCalls = false;
  for (const step of steps) {
    if (step.kind !== "tools") continue;
    for (const { toolCall } of step.entries) {
      if (toolCall.parentToolCallId) hasAgentCalls = true;
      else mainCallIds.add(toolCall.toolCallId);
    }
  }
  if (!hasAgentCalls) return steps;

  const gathered: ActivityStep[] = [];
  const holderByMainCallId = new Map<string, ChatToolEntry[]>();
  const agentStepByAgent = new Map<string, ChatToolEntry[]>();
  const delegatedHere: Array<{ agentToolCallId: string; entry: ChatToolEntry }> = [];

  for (const step of steps) {
    if (step.kind !== "tools") {
      gathered.push(step);
      continue;
    }
    let mainEntries: ChatToolEntry[] | undefined;
    for (const entry of step.entries) {
      if (!entry.toolCall.parentToolCallId) {
        if (!mainEntries) {
          mainEntries = [];
          gathered.push({
            kind: "tools",
            key: step.entries[0] === entry ? step.key : `tools:${entry.toolCall.toolCallId}`,
            entries: mainEntries,
            ...(step.turnId ? { turnId: step.turnId } : {}),
            ...(step.turnInstanceId ? { turnInstanceId: step.turnInstanceId } : {}),
          });
        }
        mainEntries.push(entry);
        holderByMainCallId.set(entry.toolCall.toolCallId, mainEntries);
        continue;
      }
      const agentToolCallId = topLevelAgentOf(entry.toolCall);
      if (mainCallIds.has(agentToolCallId)) {
        delegatedHere.push({ agentToolCallId, entry });
        continue;
      }
      const known = agentStepByAgent.get(agentToolCallId);
      if (known) {
        known.push(entry);
        continue;
      }
      const agentEntries = [entry];
      agentStepByAgent.set(agentToolCallId, agentEntries);
      gathered.push({
        kind: "agent",
        key: `agent:${agentToolCallId}:${entry.toolCall.toolCallId}`,
        agentToolCallId,
        entries: agentEntries,
      });
    }
  }
  // After the main agent's calls of the step, so each delegation is followed by what its agent did.
  for (const { agentToolCallId, entry } of delegatedHere) {
    holderByMainCallId.get(agentToolCallId)?.push(entry);
  }
  return gathered;
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

  /** The call that launched the agent the main agent delegated to, however deep `toolCall` is. */
  const topLevelAgentOf = (toolCall: ToolCall): string => {
    const seen = new Set<string>();
    let current = toolCall.parentToolCallId ?? toolCall.toolCallId;
    while (!seen.has(current)) {
      seen.add(current);
      const loaded = latestToolCalls.get(current);
      const parent = loaded ? loaded.parentToolCallId : options.agents?.byToolCallId.get(current)?.parentToolCallId;
      if (!parent) return current;
      current = parent;
    }
    return current;
  };

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
    const gathered = gatherAgentSteps(steps, topLevelAgentOf);
    const baseKey = getBlockBaseKey(gathered[0]!);
    // One turn can open several blocks (thinking, then text, then tools), so number them.
    const occurrence = keyCounts.get(baseKey) ?? 0;
    keyCounts.set(baseKey, occurrence + 1);
    blocks.push({ type: "activity", key: `activity:${baseKey}:${occurrence}`, steps: gathered });
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

/**
 * A call that handed work to an agent which carries on after the call itself has returned. Before
 * the session's records name the agent, the call's own arguments say how it was launched.
 */
export function launchesBackgroundAgent(toolCall: ToolCall): boolean {
  if (toolCall.agent) return toolCall.agent.background === true;
  if (!toolCall.isSubAgent) return false;
  const args = toolCall.args;
  return typeof args === "object" && args !== null && !Array.isArray(args) && args.mode === "background";
}

/**
 * Where a call stands as far as its stretch is concerned. Handing work to a background agent is
 * done the moment the agent starts; what becomes of the agent afterwards shows on the agent's own
 * rows, in the stretches where it works, and must not keep the stretch that launched it alive.
 */
export function getStepStatus(toolCall: ToolCall): ToolCallStatus {
  return launchesBackgroundAgent(toolCall) ? getOwnToolCallStatus(toolCall) : getToolCallStatus(toolCall);
}

/** The calls of a stretch, each once: the main agent's, and those made inside agents. */
export function collectActivityCalls(steps: ActivityStep[]): { main: ToolCall[]; inAgents: ToolCall[] } {
  const seen = new Set<string>();
  const main: ToolCall[] = [];
  const inAgents: ToolCall[] = [];
  for (const step of steps) {
    if (step.kind === "reasoning") continue;
    for (const { toolCall } of step.entries) {
      // The same call can appear twice in a turn group (a start row and a later snapshot).
      if (seen.has(toolCall.toolCallId)) continue;
      seen.add(toolCall.toolCallId);
      (toolCall.parentToolCallId ? inAgents : main).push(toolCall);
    }
  }
  return { main, inAgents };
}

export function summarizeActivity(steps: ActivityStep[], nowMs?: number): ActivitySummary {
  let thoughtCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  let agentFailedCount = 0;
  let streamingThought = false;
  let startedAtMs: number | undefined;
  let endedAtMs: number | undefined;

  const observe = (start: number | undefined, end: number | undefined) => {
    if (start !== undefined) startedAtMs = startedAtMs === undefined ? start : Math.min(startedAtMs, start);
    const last = end ?? start;
    if (last !== undefined) endedAtMs = endedAtMs === undefined ? last : Math.max(endedAtMs, last);
  };

  for (const step of steps) {
    if (step.kind !== "reasoning") continue;
    thoughtCount += 1;
    if (step.entry.reasoning.streaming) streamingThought = true;
    // A model call's end also covers the reply it wrote, so only its start counts as work here.
    const at = parseTime(step.entry.reasoning.startedAt) ?? parseTime(step.entry.timestamp);
    observe(at, at);
  }

  const { main, inAgents } = collectActivityCalls(steps);
  for (const toolCall of main) {
    const status = getStepStatus(toolCall);
    if (status === "running") runningCount += 1;
    if (status === "failed") failedCount += 1;
    const startedAt = parseTime(toolCall.startedAt);
    // Handing work to a background agent takes no time. While the agent works, the stream reports
    // its latest word as that call's end, which would stretch this block for as long as it does.
    observe(startedAt, launchesBackgroundAgent(toolCall) ? startedAt : parseTime(toolCall.completedAt));
  }
  for (const toolCall of inAgents) {
    const status = getStepStatus(toolCall);
    if (status === "running") runningCount += 1;
    if (status === "failed") agentFailedCount += 1;
    observe(parseTime(toolCall.startedAt), parseTime(toolCall.completedAt));
  }

  // Agents with a step of their own here: one per continued agent, and each delegation in this
  // stretch whose agent has already done something.
  const parentIds = new Set(inAgents.map((toolCall) => toolCall.parentToolCallId));
  const agentCount = steps.filter((step) => step.kind === "agent").length
    + main.filter((toolCall) => parentIds.has(toolCall.toolCallId)).length;

  const live = runningCount > 0 || streamingThought;
  const end = live && nowMs !== undefined ? nowMs : endedAtMs;
  const durationMs = startedAtMs !== undefined && end !== undefined && end >= startedAtMs
    ? end - startedAtMs
    : undefined;
  return {
    toolCount: main.length,
    thoughtCount,
    runningCount,
    failedCount,
    agentCount,
    agentToolCount: inAgents.length,
    agentFailedCount,
    streamingThought,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
}

/**
 * For each agent, by launching call, the key of the newest stretch that has a row for it. An agent
 * that works across several of the main agent's replies has a row in each stretch; this tells the
 * rows which of them is the current one. Pass the previous answer to get it back when nothing
 * moved, so the rows that read it are not told it changed every time the transcript does.
 */
export function mapLatestAgentBlocks(
  blocks: readonly ChatRenderBlock[],
  previous?: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "activity") continue;
    for (const step of block.steps) {
      if (step.kind === "reasoning") continue;
      if (step.kind === "agent") latest.set(step.agentToolCallId, block.key);
      for (const { toolCall } of step.entries) {
        if (toolCall.isSubAgent) latest.set(toolCall.toolCallId, block.key);
        if (toolCall.parentToolCallId) latest.set(toolCall.parentToolCallId, block.key);
      }
    }
  }
  if (previous && previous.size === latest.size) {
    let same = true;
    for (const [agentToolCallId, blockKey] of latest) {
      if (previous.get(agentToolCallId) !== blockKey) {
        same = false;
        break;
      }
    }
    if (same) return previous;
  }
  return latest;
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
