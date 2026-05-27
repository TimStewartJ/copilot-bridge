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
 */
export function deriveModelStateFromEventsFile(eventsPath: string): DerivedModelState {
  try {
    const content = readFileSync(eventsPath, "utf-8");
    return deriveModelStateFromEventsContent(content);
  } catch {
    return {};
  }
}
