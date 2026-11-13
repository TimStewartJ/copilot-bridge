import { memo, useMemo } from "react";
import type { ToolCall } from "../../api";
import { readAskUserRecord, type AskUserField, type AskUserOutcome, type AskUserRecord } from "../../lib/ask-user-record";
import { formatDuration, getToolDurationMs } from "../../lib/tool-presentation";
import { DS, cx } from "../../design/tokens";
import PromptMarkdown from "./PromptMarkdown";
import ToolIcon from "./ToolIcon";

function describeOutcome(outcome: AskUserOutcome, durationMs: number | undefined): string {
  switch (outcome) {
    case "answered":
      return durationMs !== undefined && durationMs >= 60_000
        ? `answered after ${formatDuration(durationMs)}`
        : "answered";
    case "declined":
      return "you declined";
    case "cancelled":
      return "you dismissed it";
    case "away":
      return "not answered, the run went on without you";
    case "autopilot":
      return "Autopilot went on without you";
    case "skipped":
      return "you sent a message instead";
    case "failed":
      return "the question failed";
    case "unanswered":
      return "no answer recorded";
    default:
      return "not answered";
  }
}

function formatTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A field the question offered, for a question that has no answer to show. */
function OfferedField({ field }: { field: AskUserField }) {
  return (
    <div className="min-w-0" data-ask-user-field={field.key || undefined}>
      {field.title && <div className={DS.text.sectionLabel}>{field.title}</div>}
      {field.options.length > 0 && (
        <ul className={cx("space-y-0.5", field.title && "mt-1")}>
          {field.options.map((option, index) => (
            <li key={`${index}:${option}`} className="min-w-0 break-words text-[13px] leading-5 text-text-secondary">
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface AskUserRecordViewProps {
  toolCall: ToolCall;
  record: AskUserRecord;
  /** Inside a tool call's details the header and question are already there to open from. */
  variant?: "transcript" | "detail";
  /** The question is still open, so the lack of an answer is not an outcome yet. */
  waiting?: boolean;
}

/**
 * A question the agent asked and what came of it. The question is the agent speaking, so it reads
 * as content. Below it is the answer as the CLI recorded it, or, when there is none, the fields
 * the question offered.
 */
export function AskUserRecordView({ toolCall, record, variant = "transcript", waiting = false }: AskUserRecordViewProps) {
  const durationMs = getToolDurationMs(toolCall);
  const time = formatTime(toolCall.startedAt);
  const outcome = describeOutcome(record.outcome, durationMs);
  const showOffered = record.outcome !== "answered" && record.fields.length > 0;
  const boxClassName = variant === "detail"
    ? "mt-2.5 space-y-3 border-l border-border pl-3"
    : cx("mt-2.5 space-y-3 px-3 py-2.5", DS.surface.inset);

  return (
    <div className="min-w-0" data-ask-user-record={record.outcome}>
      {variant === "transcript" && (
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <ToolIcon name="question" size={13} className="shrink-0 text-text-faint" />
          <span className="shrink-0 font-medium text-text-secondary">Asked you</span>
          <span className={cx("min-w-0 truncate text-xs tabular-nums", record.outcome === "failed" ? DS.tone.danger : "text-text-faint")}>
            {[time, outcome].filter(Boolean).join(" · ")}
          </span>
        </div>
      )}
      <PromptMarkdown content={record.message} trusted />
      {record.answer && (
        <div className={boxClassName} data-ask-user-answer="">
          <div className="min-w-0">
            <div className={DS.text.sectionLabel}>Your answer</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">{record.answer}</div>
          </div>
        </div>
      )}
      {showOffered && (
        <div className={boxClassName}>
          {record.fields.map((field) => <OfferedField key={field.key || "choices"} field={field} />)}
        </div>
      )}
      {variant === "detail" && (waiting || record.outcome !== "answered") && (
        <div className={cx("mt-1.5 text-xs", record.outcome === "failed" ? DS.tone.danger : "text-text-secondary")}>
          {waiting ? "Waiting for your answer" : outcome.charAt(0).toUpperCase() + outcome.slice(1)}
        </div>
      )}
      {record.note && (
        <div className={cx("mt-1 whitespace-pre-wrap break-words", DS.text.prose)}>{record.note}</div>
      )}
    </div>
  );
}

/** The transcript's rendering of a settled `ask_user` call. */
export default memo(function AskUserRecordBlock({ toolCall }: { toolCall: ToolCall }) {
  const record = useMemo(
    () => readAskUserRecord(toolCall),
    [toolCall.args, toolCall.name, toolCall.result, toolCall.success],
  );
  if (!record) return null;
  return <AskUserRecordView toolCall={toolCall} record={record} />;
});
