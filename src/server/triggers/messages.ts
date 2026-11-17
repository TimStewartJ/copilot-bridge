// Messages a trigger queues for its chat through the delivery outbox: results, notices, prompts.

import { randomUUID } from "node:crypto";
import { formatTriggerCheckChange, type TriggerCheckChange } from "./check.js";

export const TRIGGER_RESULT_PROMPT_PREFIX = "<trigger-result>";
export const TRIGGER_MESSAGE_PROMPT_PREFIX = "<trigger>";
/** Prefix of results queued by defers before triggers; still in chat histories and the outbox. */
export const LEGACY_DEFER_RESULT_PROMPT_PREFIX = "<deferred-work-result>";

const RESULT_INTRO = "A trigger's temporary worker returned this result. Continue from it:";

const RESULT_PATTERN = new RegExp([
  `^${TRIGGER_RESULT_PROMPT_PREFIX}\\r?\\n`,
  "triggerId: ([^\\r\\n]+)",
  "(?:\\r?\\ndeliveryId: ([^\\r\\n]+))?",
  "(\\r?\\ncontinues: true)?",
  "\\r?\\n</trigger-result>",
].join(""));
const LEGACY_RESULT_PATTERN = new RegExp([
  `^${LEGACY_DEFER_RESULT_PROMPT_PREFIX}\\r?\\n`,
  "deferId: (?:once|interval)_([^\\r\\n]+)\\r?\\n",
  "kind: (?:once|interval)",
  "(?:\\r?\\ndeliveryId: ([^\\r\\n]+))?",
  "(\\r?\\ncontinues: true)?",
  "\\r?\\n</deferred-work-result>",
].join(""));

/** A message for a chat, queued in the outbox. */
export interface TriggerDelivery {
  id: string;
  sessionId: string;
  sourceId: string;
  prompt: string;
}

export interface ParsedTriggerResult {
  triggerId: string;
  deliveryId?: string;
  /** The trigger stayed active after this result. */
  continues: boolean;
}

/** The outbox source id of messages a trigger queued. */
export function triggerDeliverySourceId(triggerId: string): string {
  return `trigger:${triggerId}`;
}

/** Source ids a trigger's messages may carry, including those queued while it was a defer. */
export function triggerDeliverySourceIds(triggerId: string): string[] {
  return [triggerDeliverySourceId(triggerId), `once_${triggerId}`, `interval_${triggerId}`];
}

export function createTriggerResultDelivery(
  input: { triggerId: string; parentSessionId: string },
  message: string,
  options: { continues?: boolean; deliveryId?: string } = {},
): TriggerDelivery {
  const deliveryId = options.deliveryId ?? randomUUID();
  return {
    id: deliveryId,
    sessionId: input.parentSessionId,
    sourceId: triggerDeliverySourceId(input.triggerId),
    prompt: [
      TRIGGER_RESULT_PROMPT_PREFIX,
      `triggerId: ${input.triggerId}`,
      `deliveryId: ${deliveryId}`,
      ...(options.continues ? ["continues: true"] : []),
      "</trigger-result>",
      "",
      RESULT_INTRO,
      "",
      message,
      ...(options.continues ? ["", "The trigger remains active."] : []),
    ].join("\n"),
  };
}

function label(input: { triggerId: string; name?: string }): string {
  return input.name ? `"${input.name}" (${input.triggerId})` : input.triggerId;
}

export function createFailedTriggerDelivery(
  input: { triggerId: string; parentSessionId: string; name?: string },
  attempts: number,
  lastError: string,
): TriggerDelivery {
  return createTriggerResultDelivery(input, [
    `FINAL TRIGGER RESULT: The trigger ${label(input)} failed after ${attempts} attempts.`,
    `Last error: ${lastError}`,
    "",
    "The trigger is no longer active. Reactivate it with trigger_update after resolving the error.",
  ].join("\n"));
}

/** Tells the chat a recurring trigger keeps failing; it stays active and the chat decides. */
export function createFailingTriggerDelivery(
  input: { triggerId: string; parentSessionId: string; name?: string },
  failures: number,
  lastError: string,
  nextRunAt: string,
): TriggerDelivery {
  return createTriggerResultDelivery(input, [
    `The last ${failures} runs of the trigger ${label(input)} failed, so nothing was checked in that time.`,
    `Last error: ${lastError}`,
    "",
    `The trigger is still active: it will try again at ${nextRunAt} and on its usual schedule after that, and you will not be told about further failures. Leave it running if the error looks temporary. If the error will not clear by itself, fix the cause, or cancel the trigger and say so.`,
  ].join("\n"), { continues: true });
}

/** The trigger's own prompt, sent straight into its chat (action chat/message). */
export function createTriggerMessageDelivery(
  input: { triggerId: string; parentSessionId: string; name?: string; prompt: string; continues: boolean },
  check?: TriggerCheckChange,
): TriggerDelivery {
  return {
    id: randomUUID(),
    sessionId: input.parentSessionId,
    sourceId: triggerDeliverySourceId(input.triggerId),
    prompt: [
      `${TRIGGER_MESSAGE_PROMPT_PREFIX}`,
      `triggerId: ${input.triggerId}`,
      ...(input.name ? [`name: ${JSON.stringify(input.name)}`] : []),
      ...(input.continues ? ["continues: true"] : []),
      "</trigger>",
      "",
      ...(check ? [formatTriggerCheckChange(check), ""] : []),
      input.prompt,
    ].join("\n"),
  };
}

export function parseTriggerResultPrompt(prompt: string): ParsedTriggerResult | undefined {
  const match = RESULT_PATTERN.exec(prompt) ?? LEGACY_RESULT_PATTERN.exec(prompt);
  if (!match) return undefined;
  const [, triggerId, deliveryId, continues] = match;
  return {
    triggerId: triggerId!,
    ...(deliveryId ? { deliveryId } : {}),
    continues: continues !== undefined,
  };
}

/** Prefixes of prompts the Bridge queued for a chat on a trigger's behalf. */
export const TRIGGER_AUTOMATED_PROMPT_PREFIXES = [
  TRIGGER_RESULT_PROMPT_PREFIX,
  TRIGGER_MESSAGE_PROMPT_PREFIX,
  LEGACY_DEFER_RESULT_PROMPT_PREFIX,
];
