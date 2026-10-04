import { randomUUID } from "node:crypto";

export const DEFERRED_WORK_RESULT_PROMPT_PREFIX = "<deferred-work-result>";
const RETURNED_RESULT_INTRO =
  "A temporary deferred-work session returned this result. Continue from it:";
const RETURNED_RESULT_INTRO_PATTERN =
  "A temporary deferred-work session returned this result\\. Continue from it(?: without repeating the completed check)?:";
const RETURNED_RESULT_PATTERN = new RegExp([
  `^${DEFERRED_WORK_RESULT_PROMPT_PREFIX}\\r?\\n`,
  "deferId: ((once|interval)_[^\\r\\n]+)\\r?\\n",
  "kind: (once|interval)",
  "(?:\\r?\\ndeliveryId: ([^\\r\\n]+))?",
  "(\\r?\\ncontinues: true)?",
  "\\r?\\n</deferred-work-result>\\r?\\n\\r?\\n",
  RETURNED_RESULT_INTRO_PATTERN,
].join(""));

export interface DeferredWorkResultMessage {
  deferId: string;
  kind: "once" | "interval";
  deliveryId?: string;
  continues: boolean;
}

export interface DeferredResultDelivery {
  id: string;
  sessionId: string;
  sourceId: string;
  prompt: string;
}

export function createReturnedDeferDelivery(
  input: Pick<DeferredWorkResultMessage, "deferId" | "kind"> & { parentSessionId: string },
  message: string,
  options: { continues?: boolean; deliveryId?: string } = {},
): DeferredResultDelivery {
  const deliveryId = options.deliveryId ?? randomUUID();
  return {
    id: deliveryId,
    sessionId: input.parentSessionId,
    sourceId: input.deferId,
    prompt: [
      DEFERRED_WORK_RESULT_PROMPT_PREFIX,
      `deferId: ${input.deferId}`,
      `kind: ${input.kind}`,
      `deliveryId: ${deliveryId}`,
      ...(options.continues ? ["continues: true"] : []),
      "</deferred-work-result>",
      "",
      RETURNED_RESULT_INTRO,
      "",
      message,
      ...(options.continues ? ["", "The recurring deferred check remains active."] : []),
    ].join("\n"),
  };
}

export function createFailedDeferDelivery(
  input: Pick<DeferredWorkResultMessage, "deferId" | "kind"> & {
    parentSessionId: string;
    name?: string;
  },
  attempts: number,
  lastError: string,
): DeferredResultDelivery {
  const label = input.name
    ? `"${input.name}" (${input.deferId})`
    : input.deferId;
  const workstream = input.kind === "interval" ? "Monitoring" : "Deferred work";
  return createReturnedDeferDelivery(input, [
    `FINAL DEFER RESULT: The ${input.kind === "interval" ? "recurring" : "one-shot"} defer ${label} failed after ${attempts} attempts.`,
    `Last error: ${lastError}`,
    "",
    `${workstream} is no longer active. Reactivate the defer after resolving the error.`,
  ].join("\n"));
}

/** Tells the chat that a recurring defer keeps failing. The defer stays active, so the chat decides what to do. */
export function createFailingLoopDelivery(
  input: Pick<DeferredWorkResultMessage, "deferId" | "kind"> & {
    parentSessionId: string;
    name?: string;
  },
  failures: number,
  lastError: string,
  nextRunAt: string,
): DeferredResultDelivery {
  const label = input.name ? `"${input.name}" (${input.deferId})` : input.deferId;
  return createReturnedDeferDelivery(input, [
    `The last ${failures} checks of the recurring defer ${label} failed, so nothing was checked in that time.`,
    `Last error: ${lastError}`,
    "",
    `The defer is still active: it will try again at ${nextRunAt} and on its usual schedule after that, and you will not be told about further failures. Leave it running if the error looks temporary. If the error will not clear by itself, fix the cause, or cancel the defer and say so.`,
  ].join("\n"), { continues: true });
}

export function parseReturnedDeferPrompt(prompt: string): DeferredWorkResultMessage | undefined {
  const match = RETURNED_RESULT_PATTERN.exec(prompt);
  if (!match || match[2] !== match[3]) return undefined;
  const [, deferId, , kind, deliveryId, continues] = match;
  return {
    deferId: deferId!,
    kind: kind as "once" | "interval",
    ...(deliveryId ? { deliveryId } : {}),
    continues: continues !== undefined,
  };
}
