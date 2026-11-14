// agent-text-audit-file: tool-output (ask_user results the agent runtime writes)
import type { ToolArgs, ToolCall } from "../api";
import { readAutomaticAnswerReason } from "../../shared/automatic-answer.js";

/**
 * Reads a finished `ask_user` call back into the question that was asked and what came of it.
 *
 * The question comes from the call's own arguments. The answer is the text the Copilot CLI recorded
 * for it, shown as written: the CLI owns that wording and changes it between releases, so Bridge
 * does not take it apart into fields or choices.
 */

export type AskUserOutcome =
  | "answered"
  | "declined"
  | "cancelled"
  /** Nobody answered in time, or the form was declined, and the run went on. */
  | "away"
  /** The chat was in Autopilot, so the question was answered without being shown. */
  | "autopilot"
  /** The user sent a message instead of answering. */
  | "skipped"
  | "failed"
  | "unanswered"
  | "other";

/** A field the question offered, as the agent asked for it. */
export interface AskUserField {
  key: string;
  title: string;
  description?: string;
  /** Labels of the choices offered, in order; empty for a free-form field. */
  options: string[];
}

export interface AskUserRecord {
  message: string;
  fields: AskUserField[];
  outcome: AskUserOutcome;
  /** The answer as the CLI recorded it. */
  answer?: string;
  /** What the tool returned when it was not an answer (a failure or an unexpected reply). */
  note?: string;
}

type ArgObject = Record<string, ToolArgs>;

const ANSWER_LABEL = /^user responded:/i;

function isObject(value: ToolArgs | undefined): value is ArgObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: ToolArgs | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isAskUserToolName(name: string): boolean {
  return name.trim().replace(/^bridge-tools-(?:session-)?/i, "").toLowerCase() === "ask_user";
}

function optionLabels(entries: ToolArgs | undefined, names?: ToolArgs): string[] {
  if (!Array.isArray(entries)) return [];
  const labels = Array.isArray(names) ? names : [];
  return entries.flatMap((entry, index) => {
    if (typeof entry === "string") {
      const label = labels[index];
      return [typeof label === "string" && label.trim() ? label : entry];
    }
    if (isObject(entry) && typeof entry.const === "string") return [text(entry.title) ?? entry.const];
    return [];
  });
}

function readField(key: string, schema: ArgObject): AskUserField {
  const items = isObject(schema.items) ? schema.items : undefined;
  const options = items
    ? optionLabels(items.enum ?? items.anyOf)
    : schema.enum !== undefined ? optionLabels(schema.enum, schema.enumNames) : optionLabels(schema.oneOf);
  return {
    key,
    title: text(schema.title) ?? key,
    ...(text(schema.description) ? { description: text(schema.description) } : {}),
    options,
  };
}

function readFields(args: ArgObject): AskUserField[] {
  const schema = isObject(args.requestedSchema) ? args.requestedSchema : undefined;
  const properties = schema && isObject(schema.properties) ? schema.properties : undefined;
  if (properties) {
    return Object.entries(properties).flatMap(([key, field]) => (isObject(field) ? [readField(key, field)] : []));
  }
  // The older form: one question, optionally with a list of choices.
  const options = optionLabels(args.choices);
  return options.length > 0 ? [{ key: "", title: "", options }] : [];
}

function classify(toolCall: Pick<ToolCall, "success">, result: string | undefined): AskUserOutcome {
  if (toolCall.success === false) return "failed";
  if (result === undefined) return "unanswered";
  // A reply Bridge gave in the user's place arrives as an answer, so it is recognised first.
  const automatic = readAutomaticAnswerReason(result);
  if (automatic) return automatic === "unanswered" ? "away" : automatic;
  if (ANSWER_LABEL.test(result)) return "answered";
  if (/^user (?:cancell?ed|dismissed)/i.test(result)) return "cancelled";
  if (/^user declined/i.test(result)) return "declined";
  if (/not available to respond/i.test(result)) return "away";
  return "other";
}

export function readAskUserRecord(toolCall: Pick<ToolCall, "name" | "args" | "result" | "success">): AskUserRecord | null {
  if (!isAskUserToolName(toolCall.name) || !isObject(toolCall.args)) return null;
  const message = text(toolCall.args.message) ?? text(toolCall.args.question);
  if (!message) return null;

  const fields = readFields(toolCall.args);
  const result = toolCall.result?.trim() ? toolCall.result.trim() : undefined;
  const outcome = classify(toolCall, result);
  if (outcome === "answered") {
    const answer = result!.replace(ANSWER_LABEL, "").replace(/\r\n?/g, "\n").trim();
    return { message, fields, outcome, ...(answer ? { answer } : {}) };
  }
  const note = outcome === "failed" || outcome === "other" ? result : undefined;
  return { message, fields, outcome, ...(note ? { note } : {}) };
}

/** A root-level question that has settled: it belongs in the conversation, not in the agent's steps. */
export function isSettledAskUserCall(toolCall: ToolCall, includeUnfinished: boolean): boolean {
  if (toolCall.parentToolCallId || toolCall.isSubAgent || !isAskUserToolName(toolCall.name)) return false;
  const settled = toolCall.success !== undefined || Boolean(toolCall.completedAt) || Boolean(toolCall.result?.trim());
  if (!settled && !includeUnfinished) return false;
  return readAskUserRecord(toolCall) !== null;
}
