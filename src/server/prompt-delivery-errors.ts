export const PROMPT_DELIVERY_ABORTED_MESSAGE = "Session was aborted before the prompt was accepted";
export const PROMPT_DELIVERY_SHUTDOWN_MESSAGE = "Session shut down before the prompt was accepted";

export function isPromptDeliveryInterruptedError(err: unknown): boolean {
  return err instanceof Error && (
    err.message === PROMPT_DELIVERY_ABORTED_MESSAGE ||
    err.message === PROMPT_DELIVERY_SHUTDOWN_MESSAGE
  );
}
