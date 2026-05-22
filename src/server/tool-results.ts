import type { ToolResultObject, ToolTelemetry } from "@github/copilot-sdk";

export type ToolFailureResultType = Exclude<ToolResultObject["resultType"], "success">;

export interface ToolFailureOptions {
  detail?: string;
  sessionLog?: string;
  resultType?: ToolFailureResultType;
  toolTelemetry?: Record<string, unknown>;
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

function normalizeToolTelemetry(toolTelemetry: Record<string, unknown> | undefined): ToolTelemetry | undefined {
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
