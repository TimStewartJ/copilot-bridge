/** Latest model/effort from events.jsonl; model_change without effort keeps it, except via auto. */

import { readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { AUTO_MODEL_ID, autoTierFromEvent } from "./agent-backend/copilot-fusion.js";
import { scanJsonlRecords } from "./jsonl-lines.js";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";
import { isRecord } from "../shared/is-record.js";

export interface DerivedModelState {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier | null;
}

interface ExtractedModelEvent extends DerivedModelState {
  preserveReasoningEffort: boolean;
  preserveContextTier: boolean;
}

export function isSubagentScopedEvent(event: Record<string, unknown> | null | undefined): boolean {
  return typeof event?.agentId === "string" && event.agentId.length > 0;
}

/** An event without effort keeps the earlier one, but not across `auto`: tiers aren't efforts. */
function keepsEarlierReasoningEffort(state: DerivedModelState, next: DerivedModelState, preserve: boolean): boolean {
  return preserve && state.reasoningEffort !== undefined && (state.model === AUTO_MODEL_ID) === (next.model === AUTO_MODEL_ID);
}

function extractFromEvent(event: unknown): ExtractedModelEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return null;
  // Sub-agents log their own session.model_change in the parent's log; it is not the session's.
  if (isSubagentScopedEvent(e)) return null;

  const type = e.type;
  if (type === "session.model_change") {
    const model = typeof data.newModel === "string" ? data.newModel : undefined;
    const reasoningEffort =
      typeof data.reasoningEffort === "string" ? data.reasoningEffort : autoTierFromEvent(model, data);
    const hasContextTier = "contextTier" in data;
    const contextTier = data.contextTier === null ? null : isCopilotContextTier(data.contextTier) ? data.contextTier : undefined;
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
      typeof data.reasoningEffort === "string" ? data.reasoningEffort : autoTierFromEvent(model, data);
    const contextTier = data.contextTier === null ? null : isCopilotContextTier(data.contextTier) ? data.contextTier : undefined;
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

/** Latest model state in events.jsonl content; reads every line so the last match wins. */
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
          ...(keepsEarlierReasoningEffort(state, nextState, preserveReasoningEffort)
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

/** Sync whole-file read for small logs and tests; request paths use the Async variant. */
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
      ...(keepsEarlierReasoningEffort(state, nextState, preserveReasoningEffort)
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

/** Tail first: a self-contained model event there wins; else stream the rest and fold the tail. */
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

/** Bytes from the end of the log that {@link turnOrModelChangeSince} reads. */
const ACTIVITY_TAIL_BYTES = 1024 * 1024;
const ACTIVITY_MARKER_BYTES = ['"user.message"', '"session.model_change"'].map((marker) => Buffer.from(marker));

function eventTime(event: unknown): number {
  const timestamp = isRecord(event) ? event.timestamp : undefined;
  return typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
}

/** Tail-only read: undefined when the tail has no match and doesn't reach `since`, or on error. */
export async function turnOrModelChangeSince(eventsPath: string, since: number): Promise<boolean | undefined> {
  let file: FileHandle;
  try {
    file = await open(eventsPath, "r");
  } catch {
    return undefined;
  }
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - ACTIVITY_TAIL_BYTES);
    let reachesBack = start === 0;
    let found = false;
    let records = 0;
    const visit = (record: Buffer) => {
      records += 1;
      // A window starting mid-log starts mid-record; the next record shows how far back it reaches.
      if (start > 0 && records === 1) return;
      if (start > 0 && records === 2) {
        try {
          reachesBack = eventTime(JSON.parse(record.toString("utf-8"))) < since;
        } catch { /* an unreadable record leaves the reach unknown */ }
      }
      if (found || !ACTIVITY_MARKER_BYTES.some((marker) => record.includes(marker))) return;
      try {
        const event: unknown = JSON.parse(record.toString("utf-8"));
        found = isRecord(event)
          && (event.type === "user.message" || event.type === "session.model_change")
          && !isSubagentScopedEvent(event)
          && eventTime(event) >= since;
      } catch { /* skip malformed lines */ }
    };
    const scan = await scanJsonlRecords(file, visit, { start, end: size });
    if (scan.trailing) visit(scan.trailing.record);
    return found ? true : reachesBack ? false : undefined;
  } catch {
    return undefined;
  } finally {
    await file.close().catch(() => {});
  }
}
