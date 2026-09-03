import { randomUUID } from "node:crypto";

export const DEFERRED_WORK_RESULT_PROMPT_PREFIX = "<deferred-work-result>";

export interface DeferredWorkResultMessage {
  deferId: string;
  kind: "once" | "interval";
  deliveryId?: string;
  continues: boolean;
}

export function formatReturnedDeferPrompt(
  input: Pick<DeferredWorkResultMessage, "deferId" | "kind">,
  message: string,
  options: { continues?: boolean; deliveryId?: string } = {},
): string {
  const deliveryId = options.deliveryId ?? randomUUID();
  return [
    DEFERRED_WORK_RESULT_PROMPT_PREFIX,
    `deferId: ${input.deferId}`,
    `kind: ${input.kind}`,
    `deliveryId: ${deliveryId}`,
    ...(options.continues ? ["continues: true"] : []),
    "</deferred-work-result>",
    "",
    "A temporary deferred-work session returned this result. Continue from it without repeating the completed check:",
    "",
    message,
    ...(options.continues ? ["", "The recurring deferred check remains active."] : []),
  ].join("\n");
}

export function parseReturnedDeferPrompt(prompt: string): DeferredWorkResultMessage | undefined {
  const closingTag = "</deferred-work-result>";
  const closingIndex = prompt.indexOf(closingTag);
  if (!prompt.startsWith(`${DEFERRED_WORK_RESULT_PROMPT_PREFIX}\n`) || closingIndex < 0) {
    return undefined;
  }

  const lines = prompt.slice(
    DEFERRED_WORK_RESULT_PROMPT_PREFIX.length + 1,
    closingIndex,
  ).trimEnd().split(/\r?\n/);
  const values = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(": ");
    if (separator < 1) return undefined;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (!["deferId", "kind", "deliveryId", "continues"].includes(key) || values.has(key)) {
      return undefined;
    }
    values.set(key, value);
  }

  const deferId = values.get("deferId");
  const kind = values.get("kind");
  const deliveryId = values.get("deliveryId");
  const continues = values.get("continues");
  const body = prompt.slice(closingIndex + closingTag.length).replace(/^\r?\n\r?\n/, "");
  if (
    !deferId
    || (!deferId.startsWith("once_") && !deferId.startsWith("interval_"))
    || (kind !== "once" && kind !== "interval")
    || (deliveryId !== undefined && !deliveryId.trim())
    || (continues !== undefined && continues !== "true")
    || !body.startsWith(
      "A temporary deferred-work session returned this result. Continue from it without repeating the completed check:",
    )
  ) {
    return undefined;
  }

  return {
    deferId,
    kind,
    ...(deliveryId ? { deliveryId } : {}),
    continues: continues === "true",
  };
}
