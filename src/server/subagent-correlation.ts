import { getToolExecutionDisplayText } from "./tool-results.js";
import type { AgentInstruction } from "../shared/subagent.js";

// Seal only failures, only on real completion (not turn-end synthesis); identity/response may lag.

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

  /** The tool call's entry, or undefined when sealed; a failure never revives a sealed call. */
  private mutableEntry(toolCallId: string, create: boolean): CorrelationEntry | undefined {
    if (this.sealed.has(toolCallId)) return undefined;
    const existing = this.entries.get(toolCallId);
    if (existing || !create) return existing;
    const created: CorrelationEntry = { started: false };
    this.entries.set(toolCallId, created);
    return created;
  }

  /** Accepted after sealing: a background launch completes before its start event arrives. */
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

  /** Accepted after sealing: a background agent answers long after its launch completed. */
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

  /** `session.error` with an `agentId`; only a known sub-agent's id is correlated. */
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
    // Older runtimes reuse the spawning `toolCallId` as `agentId`; accept it for tracked agents.
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

  /** Live fold only (frees response text); replay needs it for pass two. Sealed set survives. */
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

/** A correlated sub-agent failure overrides success and the generic no-response text. */
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
