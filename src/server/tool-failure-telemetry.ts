import { classifyToolFailure, type ToolFailure } from "../shared/tool-failure.js";

export interface ToolFailureContext {
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  durationMs?: number;
  deferId?: string;
  runCount?: number;
  workerSessionId?: string;
}

type RecordSpan = (
  name: string,
  duration: number,
  sessionId?: string,
  metadata?: Record<string, unknown>,
) => void;

export function recordToolFailure(
  result: unknown,
  context: ToolFailureContext,
  recordSpan: RecordSpan | undefined,
  logger: Pick<Console, "warn"> = console,
): ToolFailure {
  const failure = classifyToolFailure(result);
  const { sessionId, durationMs = 0, ...labels } = context;
  try {
    recordSpan?.("tool.failure", durationMs, sessionId, {
      ...labels,
      toolName: context.toolName.slice(0, 256),
      ...(context.toolCallId ? { toolCallId: context.toolCallId.slice(0, 256) } : {}),
      ...failure,
    });
  } catch {
    logger.warn("[tool.failure] Failed to persist tool failure diagnostics.");
  }
  return failure;
}
