import type { ToolResultObject } from "@github/copilot-sdk";

export type ToolFailureResultType = Exclude<ToolResultObject["resultType"], "success">;
export type BridgeToolNextAction = "respond" | "wait" | "retry" | "manual_recovery";

export interface ToolFailureOptions {
  detail?: string;
  sessionLog?: string;
  resultType?: ToolFailureResultType;
  toolTelemetry?: Record<string, unknown>;
}

export interface BridgeToolControlMetadata {
  summary: string;
  changed?: boolean;
  terminal?: boolean;
  toolNextAction?: BridgeToolNextAction;
  retryable?: boolean;
  pollAfterMs?: number;
}

export interface OkResult<T> {
  ok: true;
  value: T;
}

export interface ErrorResult<E = string> {
  ok: false;
  error: E;
}

export type Result<T, E = string> = OkResult<T> | ErrorResult<E>;

function normalizeText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function detailIncludesSummary(detail: string, summary: string): boolean {
  if (detail.includes(summary)) return true;
  const summaryStem = summary.replace(/[.!?:]+$/, "");
  return summaryStem.length > 0 && detail.includes(summaryStem);
}

function mergeFailureText(summary: string | undefined, detail: string | undefined): string | undefined {
  const normalizedSummary = normalizeText(summary);
  const normalizedDetail = normalizeText(detail);
  if (!normalizedSummary) return normalizedDetail;
  if (!normalizedDetail) return normalizedSummary;
  return detailIncludesSummary(normalizedDetail, normalizedSummary)
    ? normalizedDetail
    : joinFailureSections(normalizedSummary, normalizedDetail);
}

function getDisplayText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatNextAction(nextAction: BridgeToolNextAction | undefined, pollAfterMs: number | undefined): string | undefined {
  switch (nextAction) {
    case "respond":
      return "respond to the user; do not call another tool for this status";
    case "wait":
      return pollAfterMs
        ? `wait at least ${Math.ceil(pollAfterMs / 1000)}s before checking again`
        : "wait; do not issue marker or no-op tools";
    case "retry":
      return "retry the intended operation directly";
    case "manual_recovery":
      return "report the blocker and wait for manual recovery";
    default:
      return undefined;
  }
}

function formatBridgeToolControlText(metadata: BridgeToolControlMetadata): string {
  const contract = Object.fromEntries(
    Object.entries({
      changed: metadata.changed,
      terminal: metadata.terminal,
      nextAction: metadata.toolNextAction,
      retryable: metadata.retryable,
      pollAfterMs: metadata.pollAfterMs,
    }).filter(([, value]) => value !== undefined),
  );
  const lines = [metadata.summary];
  const nextAction = formatNextAction(metadata.toolNextAction, metadata.pollAfterMs);
  if (nextAction) lines.push(`Next action: ${nextAction}.`);
  if (Object.keys(contract).length > 0) lines.push(`Bridge tool contract: ${JSON.stringify(contract)}.`);
  return lines.join("\n");
}

function normalizeToolTelemetry(toolTelemetry: Record<string, unknown> | undefined): ToolResultObject["toolTelemetry"] {
  if (!toolTelemetry) return undefined;
  const fields = Object.fromEntries(
    Object.entries(toolTelemetry).filter(([, value]) => value !== undefined),
  );
  return Object.keys(fields).length > 0 ? { bridge: fields } : undefined;
}

export function joinFailureSections(...sections: Array<string | undefined>): string | undefined {
  const present = sections
    .map((section) => normalizeText(section))
    .filter((section): section is string => Boolean(section));
  return present.length > 0 ? present.join("\n\n") : undefined;
}

export function getToolResultDisplayText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const data = result as {
    detailedContent?: unknown;
    sessionLog?: unknown;
    content?: unknown;
    textResultForLlm?: unknown;
  };
  return getDisplayText(data.detailedContent)
    ?? getDisplayText(data.sessionLog)
    ?? getDisplayText(data.content)
    ?? getDisplayText(data.textResultForLlm);
}

export function getToolExecutionDisplayText(
  data: unknown,
  options: { subAgentResponse?: string } = {},
): string | undefined {
  if (!data || typeof data !== "object") return getDisplayText(options.subAgentResponse);

  const event = data as {
    success?: unknown;
    result?: unknown;
    error?: { message?: unknown } | unknown;
  };
  const success = event.success !== false;
  const resultText = getToolResultDisplayText(event.result);
  const directResultText = getToolResultDisplayText(event);
  const subAgentResponse = getDisplayText(options.subAgentResponse);
  const errorMessage = typeof event.error === "string"
    ? getDisplayText(event.error)
    : event.error && typeof event.error === "object"
      ? getDisplayText((event.error as { message?: unknown }).message)
      : undefined;

  if (!success) return errorMessage ?? resultText ?? directResultText;
  return subAgentResponse ?? resultText ?? directResultText;
}

export function toolFailure(summary: string, options: ToolFailureOptions = {}): ToolResultObject {
  const detail = normalizeText(options.detail);
  const textResultForLlm = mergeFailureText(summary, detail) ?? "Tool failed.";
  const sessionLog = normalizeText(options.sessionLog);
  const error = !detail && !sessionLog ? textResultForLlm : undefined;
  const toolTelemetry = normalizeToolTelemetry(options.toolTelemetry);

  return {
    textResultForLlm,
    resultType: options.resultType ?? "failure",
    ...(error ? { error } : {}),
    ...(sessionLog ? { sessionLog } : {}),
    ...(toolTelemetry ? { toolTelemetry } : {}),
  };
}

export function bridgeToolResult<T extends object>(
  result: T & BridgeToolControlMetadata,
): T & BridgeToolControlMetadata & { content: [{ type: "text"; text: string }]; message: string } & Record<string, unknown> {
  const text = formatBridgeToolControlText(result);
  return {
    ...result,
    message: "message" in result && typeof result.message === "string" ? result.message : result.summary,
    content: [{ type: "text", text }],
  } as T & BridgeToolControlMetadata & { content: [{ type: "text"; text: string }]; message: string } & Record<string, unknown>;
}

export function toolFailureWithContext<T extends object>(
  summary: string,
  context: T,
  options: ToolFailureOptions = {},
): ToolResultObject & T {
  return {
    ...toolFailure(summary, options),
    ...context,
  };
}

export function isToolErrorResult(value: unknown): value is { error?: string; resultType?: ToolFailureResultType } {
  return typeof value === "object"
    && value !== null
    && (
      typeof (value as { error?: unknown }).error === "string"
      || (
        typeof (value as { textResultForLlm?: unknown }).textResultForLlm === "string"
        && typeof (value as { resultType?: unknown }).resultType === "string"
        && (value as { resultType: ToolResultObject["resultType"] }).resultType !== "success"
      )
    );
}

export function ok<T>(value: T): OkResult<T> {
  return { ok: true, value };
}

export function err<E = string>(error: E): ErrorResult<E> {
  return { ok: false, error };
}
