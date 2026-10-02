/**
 * Derive the latest model / reasoning effort from a session's events.jsonl.
 *
 * Priority follows event recency and SDK replay semantics:
 *   session.model_change  → data.newModel, data.reasoningEffort if present
 *   session.resume        → data.selectedModel, data.reasoningEffort
 *   session.start         → data.selectedModel, data.reasoningEffort
 *
 * session.model_change events that omit reasoningEffort preserve the previous
 * reasoning effort, matching SDK event replay. Events tagged with a top-level
 * agentId belong to a sub-agent and are ignored. Malformed lines are skipped.
 */

import { readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { scanJsonlRecords } from "./jsonl-lines.js";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";

export interface DerivedModelState {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

interface ExtractedModelEvent extends DerivedModelState {
  preserveReasoningEffort: boolean;
  preserveContextTier: boolean;
}

export function isSubagentScopedEvent(event: Record<string, unknown> | null | undefined): boolean {
  return typeof event?.agentId === "string" && event.agentId.length > 0;
}

function extractFromEvent(event: unknown): ExtractedModelEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return null;
  // Sub-agents write their own session.model_change into the parent's log, tagged
  // with agentId. They describe the sub-agent's model, never the session's.
  if (isSubagentScopedEvent(e)) return null;

  const type = e.type;
  if (type === "session.model_change") {
    const model = typeof data.newModel === "string" ? data.newModel : undefined;
    const reasoningEffort =
      typeof data.reasoningEffort === "string" ? data.reasoningEffort : undefined;
    const hasContextTier = "contextTier" in data;
    const contextTier = isCopilotContextTier(data.contextTier) ? data.contextTier : undefined;
    if (model !== undefined) {
      return {
        model,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(contextTier !== undefined ? { contextTier } : {}),
        preserveReasoningEffort: reasoningEffort === undefined,
        preserveContextTier: !hasContextTier,
      };
    }
  } else if (type === "session.resume" || type === "session.start") {
    const model = typeof data.selectedModel === "string" ? data.selectedModel : undefined;
    const reasoningEffort =
      typeof data.reasoningEffort === "string" ? data.reasoningEffort : undefined;
    const contextTier = isCopilotContextTier(data.contextTier) ? data.contextTier : undefined;
    if (model !== undefined) {
      return {
        model,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(contextTier !== undefined ? { contextTier } : {}),
        preserveReasoningEffort: false,
        preserveContextTier: false,
      };
    }
  }
  return null;
}

/**
 * Parse events.jsonl content and return the latest derived model state.
 * Reads all lines so that the last matching event wins.
 */
export function deriveModelStateFromEventsContent(content: string): DerivedModelState {
  let state: DerivedModelState = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      const extracted = extractFromEvent(event);
      if (extracted !== null) {
        const { preserveReasoningEffort, preserveContextTier, ...nextState } = extracted;
        state = {
          ...nextState,
          ...(preserveReasoningEffort && state.reasoningEffort !== undefined
            ? { reasoningEffort: state.reasoningEffort }
            : {}),
          ...(preserveContextTier && state.contextTier !== undefined
            ? { contextTier: state.contextTier }
            : {}),
        };
      }
    } catch {
      // skip malformed lines
    }
  }
  return state;
}

/**
 * Read events.jsonl at the given path and derive the latest model state.
 * Returns an empty object if the file is missing or unreadable.
 *
 * Synchronous whole-file read: only for small logs and tests. Request paths must use
 * {@link deriveModelStateFromEventsFileAsync}, which bounds the read.
 */
export function deriveModelStateFromEventsFile(eventsPath: string): DerivedModelState {
  try {
    const content = readFileSync(eventsPath, "utf-8");
    return deriveModelStateFromEventsContent(content);
  } catch {
    return {};
  }
}

/** Model-bearing events are identified by these markers; other lines never need parsing. */
const MODEL_EVENT_MARKERS = ['"session.model_change"', '"session.resume"', '"session.start"'];
const MODEL_EVENT_MARKER_BYTES = MODEL_EVENT_MARKERS.map((marker) => Buffer.from(marker));
/** Bytes read from each end before falling back to a streamed scan of the whole file. */
const MODEL_STATE_HEAD_BYTES = 256 * 1024;
const MODEL_STATE_TAIL_BYTES = 2 * 1024 * 1024;

function lineMayCarryModelState(line: string): boolean {
  return MODEL_EVENT_MARKERS.some((marker) => line.includes(marker));
}

function foldModelStateLine(
  state: DerivedModelState,
  line: string,
  track?: { preservedFromEarlier: boolean },
): DerivedModelState {
  const trimmed = line.trim();
  if (!trimmed || !lineMayCarryModelState(trimmed)) return state;
  try {
    const extracted = extractFromEvent(JSON.parse(trimmed));
    if (extracted === null) return state;
    const { preserveReasoningEffort, preserveContextTier, ...nextState } = extracted;
    if (track) track.preservedFromEarlier = preserveReasoningEffort || preserveContextTier;
    return {
      ...nextState,
      ...(preserveReasoningEffort && state.reasoningEffort !== undefined
        ? { reasoningEffort: state.reasoningEffort }
        : {}),
      ...(preserveContextTier && state.contextTier !== undefined
        ? { contextTier: state.contextTier }
        : {}),
    };
  } catch {
    return state; // skip malformed lines
  }
}

/** Decodes a record only when it may carry model state. */
function modelStateLine(record: Buffer): string | undefined {
  return MODEL_EVENT_MARKER_BYTES.some((marker) => record.includes(marker))
    ? record.toString("utf-8")
    : undefined;
}

/** Folds the model-bearing records of `[start, end)`, including an unterminated last record. */
async function foldModelStateRange(
  file: FileHandle,
  state: DerivedModelState,
  range: { start: number; end: number },
  chunkBytes?: number,
): Promise<DerivedModelState> {
  let next = state;
  const fold = (record: Buffer) => {
    const line = modelStateLine(record);
    if (line !== undefined) next = foldModelStateLine(next, line);
  };
  // Yield between reads so a 100 MB log never pins the event loop.
  const { trailing } = await scanJsonlRecords(file, fold, { ...range, chunkBytes, yieldAfterMs: 0 });
  if (trailing) fold(trailing.record);
  return next;
}

/**
 * Bounded, non-blocking variant for request paths. The model is set by `session.start`
 * (head of the log) and changed by later `session.model_change` / `session.resume`
 * events, which for a live session are almost always within the last couple of MB.
 * Read the tail first: if it contains a model-bearing event that does not inherit fields
 * from an earlier one, later events win and the rest of the log is irrelevant. Otherwise
 * stream the log up to the tail window and fold the tail on top.
 */
export async function deriveModelStateFromEventsFileAsync(eventsPath: string): Promise<DerivedModelState> {
  let file: FileHandle;
  try {
    file = await open(eventsPath, "r");
  } catch {
    return {};
  }
  try {
    const { size } = await file.stat();
    if (size <= MODEL_STATE_HEAD_BYTES + MODEL_STATE_TAIL_BYTES) {
      // Small enough for one read, so the answer never waits on the event loop.
      return await foldModelStateRange(file, {}, { start: 0, end: size }, Math.max(1, size));
    }

    // The tail window starts mid-record; its first record is left to the streamed pass.
    const tailStart = size - MODEL_STATE_TAIL_BYTES;
    let tailLinesStart: number | undefined;
    const tailLines: string[] = [];
    const collectTail = (record: Buffer, offset: number) => {
      if (tailLinesStart === undefined) {
        tailLinesStart = offset + record.length + 1;
        return;
      }
      const line = modelStateLine(record);
      if (line !== undefined) tailLines.push(line);
    };
    const tail = await scanJsonlRecords(file, collectTail, { start: tailStart, end: size, chunkBytes: MODEL_STATE_TAIL_BYTES });
    if (tail.trailing && tailLinesStart !== undefined) collectTail(tail.trailing.record, tail.trailing.offset);

    const track = { preservedFromEarlier: false };
    const fromTail = tailLines.reduce((state, line) => foldModelStateLine(state, line, track), {} as DerivedModelState);
    if (fromTail.model !== undefined && !track.preservedFromEarlier) return fromTail;

    const beforeTail = await foldModelStateRange(file, {}, { start: 0, end: tailLinesStart ?? size });
    return tailLines.reduce((state, line) => foldModelStateLine(state, line), beforeTail);
  } catch {
    return {};
  } finally {
    await file.close().catch(() => {});
  }
}
