/**
 * Derive the latest model / reasoning effort from a session's events.jsonl.
 *
 * Priority follows event recency and SDK replay semantics:
 *   session.model_change  → data.newModel, data.reasoningEffort if present
 *   session.resume        → data.selectedModel, data.reasoningEffort
 *   session.start         → data.selectedModel, data.reasoningEffort
 *
 * session.model_change events that omit reasoningEffort preserve the previous
 * reasoning effort, matching SDK event replay. Malformed lines are skipped.
 */

import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
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

function extractFromEvent(event: unknown): ExtractedModelEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return null;

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
/** Bytes read from each end before falling back to a streamed scan of the whole file. */
const MODEL_STATE_HEAD_BYTES = 256 * 1024;
const MODEL_STATE_TAIL_BYTES = 2 * 1024 * 1024;
const MODEL_STATE_STREAM_CHUNK_BYTES = 256 * 1024;

function lineMayCarryModelState(line: string): boolean {
  return MODEL_EVENT_MARKERS.some((marker) => line.includes(marker));
}

function foldModelStateLines(
  state: DerivedModelState,
  content: string,
  track?: { preservedFromEarlier: boolean },
): DerivedModelState {
  let next = state;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !lineMayCarryModelState(trimmed)) continue;
    try {
      const extracted = extractFromEvent(JSON.parse(trimmed));
      if (extracted !== null) {
        const { preserveReasoningEffort, preserveContextTier, ...nextState } = extracted;
        if (track) track.preservedFromEarlier = preserveReasoningEffort || preserveContextTier;
        next = {
          ...nextState,
          ...(preserveReasoningEffort && next.reasoningEffort !== undefined
            ? { reasoningEffort: next.reasoningEffort }
            : {}),
          ...(preserveContextTier && next.contextTier !== undefined
            ? { contextTier: next.contextTier }
            : {}),
        };
      }
    } catch {
      // skip malformed lines
    }
  }
  return next;
}

/**
 * Bounded, non-blocking variant for request paths. The model is set by `session.start`
 * (head of the log) and changed by later `session.model_change` / `session.resume`
 * events, which for a live session are almost always within the last couple of MB.
 * Read the head and the tail; if the tail region is self-sufficient (it contains a
 * model-bearing event) the head is irrelevant because later events win. Only when
 * neither end carries a model event do we stream the middle, in chunks, yielding
 * between them so a 100 MB log never pins the event loop.
 */
export async function deriveModelStateFromEventsFileAsync(eventsPath: string): Promise<DerivedModelState> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(eventsPath, "r");
  } catch {
    return {};
  }
  try {
    const { size } = await file.stat();
    if (size <= MODEL_STATE_HEAD_BYTES + MODEL_STATE_TAIL_BYTES) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      return foldModelStateLines({}, buffer.subarray(0, bytesRead).toString("utf-8"));
    }

    // Tail first: the newest model-bearing event wins, so a tail hit is authoritative
    // unless that event inherits (preserves) fields from an earlier one we have not seen.
    const tailStart = size - MODEL_STATE_TAIL_BYTES;
    const tailBuffer = Buffer.alloc(MODEL_STATE_TAIL_BYTES);
    const tailRead = await file.read(tailBuffer, 0, MODEL_STATE_TAIL_BYTES, tailStart);
    const tailText = tailBuffer.subarray(0, tailRead.bytesRead).toString("utf-8");
    // Drop the partial first line of the tail window; it is covered by the streamed pass.
    const tailFromLine = tailText.indexOf("\n");
    const tailLines = tailFromLine >= 0 ? tailText.slice(tailFromLine + 1) : "";
    if (lineMayCarryModelState(tailLines)) {
      const track = { preservedFromEarlier: false };
      const fromTail = foldModelStateLines({}, tailLines, track);
      if (fromTail.model !== undefined && !track.preservedFromEarlier) return fromTail;
    }

    // Otherwise stream from the head up to the tail window in chunks, yielding between
    // them, then fold the tail on top so later events still win.
    let state: DerivedModelState = {};
    const chunk = Buffer.alloc(MODEL_STATE_STREAM_CHUNK_BYTES);
    let offset = 0;
    let leftover = "";
    const streamEnd = tailStart + (tailFromLine >= 0 ? tailFromLine + 1 : tailRead.bytesRead);
    while (offset < streamEnd) {
      const toRead = Math.min(chunk.length, streamEnd - offset);
      const { bytesRead } = await file.read(chunk, 0, toRead, offset);
      if (bytesRead === 0) break;
      const text = leftover + chunk.subarray(0, bytesRead).toString("utf-8");
      const lastNewline = text.lastIndexOf("\n");
      const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
      leftover = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
      if (lineMayCarryModelState(complete)) state = foldModelStateLines(state, complete);
      offset += bytesRead;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (leftover) state = foldModelStateLines(state, leftover);
    return foldModelStateLines(state, tailLines);
  } catch {
    return {};
  } finally {
    await file.close().catch(() => {});
  }
}
