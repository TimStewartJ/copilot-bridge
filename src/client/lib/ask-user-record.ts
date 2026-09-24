import type { ToolArgs, ToolCall } from "../api";

/**
 * Reads a finished `ask_user` call back into the question that was asked and the answer given, so
 * the transcript can show it the way the form looked instead of as its raw schema and result text.
 *
 * The CLI reports an answer as "User responded:" followed by one `key: value` line per field (older
 * calls with a single free-text question put the answer on the same line). Multi-select answers are
 * joined with ", ", so they are split back apart against the options that were offered.
 */

export type AskUserOutcome =
  | "answered"
  | "declined"
  | "cancelled"
  | "away"
  | "failed"
  | "unanswered"
  | "other";

export interface AskUserOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface AskUserField {
  key: string;
  title: string;
  description?: string;
  kind: "choice" | "multi" | "boolean" | "text";
  required: boolean;
  options: AskUserOption[];
  /** A text answer, or a choice answer that matched none of the options. */
  answer?: string;
  answered: boolean;
}

export interface AskUserRecord {
  message: string;
  fields: AskUserField[];
  outcome: AskUserOutcome;
  /** An answer to a question that had no form fields. */
  freeformAnswer?: string;
  /** What the tool returned when it was not an answer (a failure or an unexpected reply). */
  note?: string;
}

type ArgObject = Record<string, ToolArgs>;

function isObject(value: ToolArgs | undefined): value is ArgObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: ToolArgs | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isAskUserToolName(name: string): boolean {
  return name.trim().replace(/^bridge-tools-(?:session-)?/i, "").toLowerCase() === "ask_user";
}

function optionList(entries: ToolArgs | undefined, labels?: ToolArgs): Array<{ value: string; label: string }> {
  if (!Array.isArray(entries)) return [];
  const names = Array.isArray(labels) ? labels : [];
  return entries.flatMap((entry, index) => {
    if (typeof entry === "string") {
      const label = names[index];
      return [{ value: entry, label: typeof label === "string" && label.trim() ? label : entry }];
    }
    if (isObject(entry) && typeof entry.const === "string") {
      return [{ value: entry.const, label: text(entry.title) ?? entry.const }];
    }
    return [];
  });
}

interface FieldShape {
  key: string;
  title: string;
  description?: string;
  kind: AskUserField["kind"];
  required: boolean;
  options: Array<{ value: string; label: string }>;
}

function readField(key: string, schema: ArgObject, required: boolean): FieldShape {
  const base = {
    key,
    title: text(schema.title) ?? key,
    ...(text(schema.description) ? { description: text(schema.description) } : {}),
    required,
  };
  if (schema.type === "boolean") {
    return { ...base, kind: "boolean", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
  }
  if (schema.type === "array") {
    const items = isObject(schema.items) ? schema.items : {};
    return { ...base, kind: "multi", options: optionList(items.enum ?? items.anyOf) };
  }
  const options = schema.enum !== undefined ? optionList(schema.enum, schema.enumNames) : optionList(schema.oneOf);
  return { ...base, kind: options.length > 0 ? "choice" : "text", options };
}

function readShapes(args: ArgObject): FieldShape[] {
  const schema = isObject(args.requestedSchema) ? args.requestedSchema : undefined;
  const properties = schema && isObject(schema.properties) ? schema.properties : undefined;
  if (properties) {
    const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((key) => typeof key === "string") : []);
    return Object.entries(properties).flatMap(([key, field]) => (
      isObject(field) ? [readField(key, field, required.has(key))] : []
    ));
  }
  // The older form: one question, optionally with a list of choices.
  const choices = optionList(args.choices);
  return choices.length > 0
    ? [{ key: "", title: "", kind: "choice", required: true, options: choices }]
    : [];
}

function classify(toolCall: ToolCall, result: string | undefined): AskUserOutcome {
  if (toolCall.success === false) return "failed";
  if (result === undefined) return "unanswered";
  if (/^user responded:/i.test(result)) return "answered";
  if (/^user (?:cancell?ed|dismissed)/i.test(result)) return "cancelled";
  if (/^user declined/i.test(result)) return "declined";
  if (/not available to respond/i.test(result)) return "away";
  return "other";
}

/** `key: value` lines, where a line that does not start a known key continues the previous value. */
function readAnswerLines(body: string, keys: string[]): Map<string, string> {
  const answers = new Map<string, string>();
  const known = [...keys].sort((left, right) => right.length - left.length);
  let current: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const key = known.find((candidate) => line.startsWith(`${candidate}: `) || line === `${candidate}:`);
    if (key !== undefined) {
      current = key;
      answers.set(key, line.slice(key.length + 1).replace(/^ /, ""));
      continue;
    }
    if (current !== undefined) answers.set(current, `${answers.get(current)}\n${line}`);
  }
  return answers;
}

/** "a, b (x, y), c" back into the offered values it was joined from. */
function splitMulti(value: string, options: string[]): { selected: Set<string>; leftover: string[] } {
  const known = new Set(options);
  const selected = new Set<string>();
  const leftover: string[] = [];
  const parts = value.split(", ");
  let index = 0;
  while (index < parts.length) {
    let matched = 0;
    for (let end = parts.length; end > index; end -= 1) {
      if (known.has(parts.slice(index, end).join(", "))) {
        matched = end - index;
        break;
      }
    }
    if (matched > 0) {
      selected.add(parts.slice(index, index + matched).join(", "));
      index += matched;
    } else {
      if (parts[index]!.trim()) leftover.push(parts[index]!.trim());
      index += 1;
    }
  }
  return { selected, leftover };
}

function answerField(shape: FieldShape, raw: string | undefined): AskUserField {
  const value = raw?.trim();
  const unanswered = { ...shape, options: shape.options.map((option) => ({ ...option, selected: false })), answered: false };
  if (!value) return unanswered;
  if (shape.kind === "text") return { ...unanswered, answer: value, answered: true };
  if (shape.kind === "multi") {
    const { selected, leftover } = splitMulti(value, shape.options.map((option) => option.value));
    return {
      ...shape,
      options: shape.options.map((option) => ({ ...option, selected: selected.has(option.value) })),
      ...(leftover.length > 0 ? { answer: leftover.join(", ") } : {}),
      answered: true,
    };
  }
  const match = shape.options.find((option) => option.value === value)
    ?? shape.options.find((option) => option.label === value);
  return {
    ...shape,
    options: shape.options.map((option) => ({ ...option, selected: option === match })),
    ...(match ? {} : { answer: value }),
    answered: true,
  };
}

export function readAskUserRecord(toolCall: Pick<ToolCall, "name" | "args" | "result" | "success">): AskUserRecord | null {
  if (!isAskUserToolName(toolCall.name) || !isObject(toolCall.args)) return null;
  const message = text(toolCall.args.message) ?? text(toolCall.args.question);
  if (!message) return null;

  const shapes = readShapes(toolCall.args);
  const result = toolCall.result?.trim() ? toolCall.result.trim() : undefined;
  const outcome = classify(toolCall as ToolCall, result);
  const note = outcome === "failed" || outcome === "other" ? result : undefined;
  if (outcome !== "answered") {
    return {
      message,
      fields: shapes.map((shape) => answerField(shape, undefined)),
      outcome,
      ...(note ? { note } : {}),
    };
  }

  const body = result!.replace(/^user responded:/i, "");
  const keyed = shapes.filter((shape) => shape.key);
  if (keyed.length === 0) {
    const answer = body.trim();
    // A single-choice question from the older form carries its answer as the whole reply.
    if (shapes.length === 1) return { message, fields: [answerField(shapes[0]!, answer)], outcome };
    return { message, fields: [], outcome, ...(answer ? { freeformAnswer: answer } : {}) };
  }

  if (!body.startsWith("\n") && !/\r?\n/.test(body)) {
    // Only the short `key=value` summary is available; with one field its value is the answer.
    const answer = body.trim();
    const single = keyed.length === 1 ? answer.replace(new RegExp(`^${escapeRegExp(keyed[0]!.key)}=`), "") : undefined;
    if (single !== undefined) return { message, fields: [answerField(keyed[0]!, single)], outcome };
    return {
      message,
      fields: shapes.map((shape) => answerField(shape, undefined)),
      outcome,
      ...(answer ? { freeformAnswer: answer } : {}),
    };
  }

  const answers = readAnswerLines(body.replace(/^\r?\n/, ""), keyed.map((shape) => shape.key));
  return { message, fields: shapes.map((shape) => answerField(shape, answers.get(shape.key))), outcome };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A root-level question that has settled: it belongs in the conversation, not in the agent's steps. */
export function isSettledAskUserCall(toolCall: ToolCall, includeUnfinished: boolean): boolean {
  if (toolCall.parentToolCallId || toolCall.isSubAgent || !isAskUserToolName(toolCall.name)) return false;
  const settled = toolCall.success !== undefined || Boolean(toolCall.completedAt) || Boolean(toolCall.result?.trim());
  if (!settled && !includeUnfinished) return false;
  return readAskUserRecord(toolCall) !== null;
}
