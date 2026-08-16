import { getToolExecutionDisplayText } from "./tool-results.js";
import type { AgentInstruction } from "../shared/subagent.js";

// Sub-agent correlation shared by the two server-side folds of the SDK event stream:
// the live fold (`session-runner.ts`, single-pass, emits SSE deltas) and the replay fold
// (`event-transform.ts`, two-pass, reads events.jsonl). Both must derive the same display name,
// success and result text for a tool call, but they cannot share a traversal: the live fold has
// no look-ahead and carries side effects, while the replay fold depends on look-ahead and must
// stay pure. Only the derivation is shared here.
//
// Ordering rule ("seal on completion"): a tool call stops accepting *failure* updates once its
// real `tool.execution_complete` arrives. Background sub-agents complete their *launch*
// successfully and can fail minutes later, so a late `subagent.failed` must not retroactively
// fail the launch. Both folds ingest chronologically, so sealing yields identical results in
// single-pass and two-pass form. Turn-terminal synthesis deliberately does NOT seal, because a
// real completion can still arrive after `assistant.turn_end`.
//
// Sealing is scoped to failures only. Sub-agent identity and response text legitimately arrive
// after a background launch completes, and both folds have always surfaced them, so they are
// still recorded late.

export interface SubagentResolution {
  /** True once a sub-agent start, or an authoritative sub-agent failure, is known. */
  isSubAgent: boolean;
  displayName?: string;
  response?: string;
  error?: string;
  instructions?: string[];
}

export interface ToolCompletionRecord {
  success?: boolean;
  /** Raw `tool.execution_complete` data. Absent for turn-terminal synthesis. */
  data?: unknown;
  /** Display text for synthesized completions, which have no raw event data. */
  fallbackText?: string;
  timestamp?: string;
  eventId?: string;
}

export interface ToolOutcome {
  isSubAgent: boolean;
  displayName: string;
  success?: boolean;
  result?: string;
}

const NOT_A_SUBAGENT: SubagentResolution = { isSubAgent: false };
const FALLBACK_AGENT_NAME = "🤖 agent";

interface CorrelationEntry {
  agentId?: string;
  displayName?: string;
  response?: string;
  error?: string;
  instructions?: string[];
  /** A `subagent.started` was seen for this tool call. */
  started: boolean;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Sub-agent failures carry `data.error` as a bare string or an `{ message }` object. */
export function getSubagentFailureText(error: unknown): string | undefined {
  if (typeof error === "string") return nonEmptyString(error);
  if (error && typeof error === "object") {
    return nonEmptyString((error as { message?: unknown }).message);
  }
  return undefined;
}

export function formatSubagentDisplayName(data: unknown): string {
  const record = (data ?? {}) as { agentDisplayName?: unknown; agentName?: unknown };
  const name = nonEmptyString(record.agentDisplayName) ?? nonEmptyString(record.agentName);
  return name ? `🤖 ${name}` : FALLBACK_AGENT_NAME;
}

export class SubagentCorrelator {
  private readonly entries = new Map<string, CorrelationEntry>();
  /** Envelope `agentId` (sub-agent instance) → `data.toolCallId` (spawning tool call). */
  private readonly agentToToolCall = new Map<string, string>();
  private readonly pendingInstructions = new Map<string, string[]>();
  /** Tool calls whose real completion has been seen; they no longer accept failure updates. */
  private readonly sealed = new Set<string>();

  /**
   * Returns the entry for a tool call, or undefined when it is sealed. Sealed and forgotten tool
   * calls are never resurrected by a failure.
   */
  private mutableEntry(toolCallId: string, create: boolean): CorrelationEntry | undefined {
    if (this.sealed.has(toolCallId)) return undefined;
    const existing = this.entries.get(toolCallId);
    if (existing || !create) return existing;
    const created: CorrelationEntry = { started: false };
    this.entries.set(toolCallId, created);
    return created;
  }

  /**
   * `subagent.started`: `toolCallId` is the spawning tool call, `agentId` the instance id.
   *
   * Identity is deliberately recorded even after the tool call is sealed. Background launches
   * complete before their `subagent.started` arrives, and the live fold emits a follow-up
   * `tool_update` that renames the finished entry, so replay must accept it too. Only the failure
   * outcome is frozen by sealing.
   */
  startSubagent(toolCallId: string, agentId: string | undefined, data: unknown): void {
    let entry = this.entries.get(toolCallId);
    if (!entry) {
      entry = { started: false };
      this.entries.set(toolCallId, entry);
    }
    entry.started = true;
    entry.displayName = formatSubagentDisplayName(data);
    if (agentId) {
      entry.agentId = agentId;
      this.agentToToolCall.set(agentId, toolCallId);
      const pending = this.pendingInstructions.get(agentId);
      if (pending?.length) {
        entry.instructions = [...(entry.instructions ?? []), ...pending];
        this.pendingInstructions.delete(agentId);
      }
    }
  }

  /**
   * `assistant.message` carrying `parentToolCallId`: the sub-agent's response text.
   *
   * Like identity, this is accepted after sealing. A background agent answers long after its
   * launch tool completed, and replay has always surfaced that answer on the launch entry.
   */
  recordResponse(parentToolCallId: string, content: unknown): void {
    const text = nonEmptyString(content);
    if (!text) return;
    let entry = this.entries.get(parentToolCallId);
    if (!entry) {
      entry = { started: false };
      this.entries.set(parentToolCallId, entry);
    }
    entry.response = text;
  }

  recordInstruction(agentId: string, content: unknown): void {
    const text = nonEmptyString(content);
    if (!text) return;
    const toolCallId = this.resolveAgentToolCallId(agentId);
    if (!toolCallId) {
      const pending = this.pendingInstructions.get(agentId) ?? [];
      pending.push(text);
      this.pendingInstructions.set(agentId, pending);
      return;
    }
    this.recordInstructionForToolCall(toolCallId, text);
  }

  recordInstructionForToolCall(toolCallId: string, content: unknown): void {
    const text = nonEmptyString(content);
    if (!text) return;
    let entry = this.entries.get(toolCallId);
    if (!entry) {
      entry = { started: false };
      this.entries.set(toolCallId, entry);
    }
    entry.instructions = [...(entry.instructions ?? []), text];
  }

  /** `subagent.failed`: `data.toolCallId` is authoritative and may establish sub-agent identity. */
  recordSubagentFailure(toolCallId: string, error: unknown): void {
    const text = getSubagentFailureText(error);
    if (!text) return;
    const entry = this.mutableEntry(toolCallId, true);
    if (entry) entry.error = text;
  }

  /**
   * `session.error` carrying an envelope `agentId`. The id is only correlated when it maps to a
   * known sub-agent, so an unrelated error can never poison a normal tool call that happens to
   * share an id.
   */
  recordAgentError(agentId: string, message: unknown): void {
    const text = nonEmptyString(message);
    const toolCallId = this.resolveAgentToolCallId(agentId);
    if (!text || !toolCallId) return;
    const entry = this.mutableEntry(toolCallId, false);
    if (entry) entry.error = text;
  }

  resolveAgentToolCallId(agentId: string): string | undefined {
    const mapped = this.agentToToolCall.get(agentId);
    if (mapped) return mapped;
    // Historically the runtime set `agentId` equal to the spawning `toolCallId`. Accept that only
    // when the id already identifies a tracked sub-agent.
    return this.entries.get(agentId)?.started ? agentId : undefined;
  }

  isTrackedAgent(agentId: string): boolean {
    return this.resolveAgentToolCallId(agentId) !== undefined;
  }

  /** Real `tool.execution_complete`: freeze correlation for this tool call. */
  completeTool(toolCallId: string): void {
    this.sealed.add(toolCallId);
  }

  resolve(toolCallId: string): SubagentResolution {
    const entry = this.entries.get(toolCallId);
    if (!entry) return NOT_A_SUBAGENT;
    return {
      isSubAgent: entry.started || entry.error !== undefined,
      displayName: entry.displayName,
      response: entry.response,
      error: entry.error,
      instructions: entry.instructions ? [...entry.instructions] : undefined,
    };
  }

  /**
   * Drop retained payload for a finished tool call. The live fold calls this to avoid holding
   * sub-agent response text for the lifetime of a run; the replay fold retains everything because
   * its second pass still needs it. The sealed marker survives so late events cannot resurrect it.
   */
  forget(toolCallId: string): void {
    const entry = this.entries.get(toolCallId);
    if (entry?.agentId) {
      this.agentToToolCall.delete(entry.agentId);
      this.pendingInstructions.delete(entry.agentId);
    }
    this.entries.delete(toolCallId);
  }
}

function getPromptArgument(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return nonEmptyString((args as Record<string, unknown>).prompt);
}

function normalizeInstructionComparison(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildSubagentInstructions(
  args: unknown,
  observedInstructions: readonly string[] = [],
): AgentInstruction[] | undefined {
  const initialPrompt = getPromptArgument(args);
  const instructions: AgentInstruction[] = [];
  if (initialPrompt) instructions.push({ kind: "task", content: initialPrompt });

  let skippedInitialEvent = false;
  for (const observed of observedInstructions) {
    const content = nonEmptyString(observed);
    if (!content) continue;
    if (
      initialPrompt
      && !skippedInitialEvent
      && normalizeInstructionComparison(content) === normalizeInstructionComparison(initialPrompt)
    ) {
      skippedInitialEvent = true;
      continue;
    }
    instructions.push({
      kind: instructions.length === 0 ? "task" : "follow_up",
      content,
    });
  }

  return instructions.length > 0 ? instructions : undefined;
}

/**
 * The single place that turns a tool completion plus its sub-agent correlation into what the user
 * sees. A correlated sub-agent failure replaces both the success flag and the generic tool result
 * text, which is otherwise an unhelpful "Agent completed but produced no response."
 */
export function resolveToolOutcome(
  resolution: SubagentResolution,
  completion: ToolCompletionRecord | undefined,
  toolName: string,
): ToolOutcome {
  const { isSubAgent, error } = resolution;
  const result = error
    ?? (completion?.data !== undefined
      ? getToolExecutionDisplayText(completion.data, {
        subAgentResponse: isSubAgent ? resolution.response : undefined,
      })
      : completion?.fallbackText);
  return {
    isSubAgent,
    displayName: isSubAgent ? (resolution.displayName ?? FALLBACK_AGENT_NAME) : toolName,
    success: error ? false : completion?.success,
    result,
  };
}
