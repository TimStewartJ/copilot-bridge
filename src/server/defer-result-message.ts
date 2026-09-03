import { randomUUID } from "node:crypto";

export const DEFERRED_WORK_RESULT_PROMPT_PREFIX = "<deferred-work-result>";
const RETURNED_RESULT_INTRO =
  "A temporary deferred-work session returned this result. Continue from it without repeating the completed check:";
const RETURNED_RESULT_PATTERN = new RegExp([
  `^${DEFERRED_WORK_RESULT_PROMPT_PREFIX}\\r?\\n`,
  "deferId: ((once|interval)_[^\\r\\n]+)\\r?\\n",
  "kind: (once|interval)",
  "(?:\\r?\\ndeliveryId: ([^\\r\\n]+))?",
  "(\\r?\\ncontinues: true)?",
  "\\r?\\n</deferred-work-result>\\r?\\n\\r?\\n",
  RETURNED_RESULT_INTRO,
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
