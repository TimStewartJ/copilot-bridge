import { memo, useMemo } from "react";
import { Check } from "lucide-react";
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

function OptionLine({ label, selected, dimmed }: { label: string; selected: boolean; dimmed: boolean }) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-[13px] leading-5" data-selected={selected || undefined}>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {selected && <Check size={14} className="text-text-primary" aria-label="Chosen" />}
      </span>
      <span className={cx("min-w-0 break-words", selected ? "font-medium text-text-primary" : dimmed ? "text-text-faint" : "text-text-secondary")}>
        {label}
      </span>
    </li>
  );
}

function FieldAnswer({ field, outcome }: { field: AskUserField; outcome: AskUserOutcome }) {
  const anySelected = field.options.some((option) => option.selected);
  return (
    <div className="min-w-0" data-ask-user-field={field.key || undefined}>
      {field.title && <div className={DS.text.sectionLabel}>{field.title}</div>}
      {field.options.length > 0 && (
        <ul className={cx("space-y-0.5", field.title && "mt-1")}>
          {field.options.map((option) => (
            <OptionLine
              key={option.value}
              label={option.label}
              selected={option.selected}
              dimmed={anySelected || Boolean(field.answer)}
            />
          ))}
        </ul>
      )}
      {field.answer && (
        <div className="mt-1 flex min-w-0 items-start gap-2">
          {field.options.length > 0 && (
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              <Check size={14} className="text-text-primary" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
            {field.options.length > 0 ? `Other: ${field.answer}` : field.answer}
          </div>
        </div>
      )}
      {!field.answered && outcome === "answered" && field.options.length === 0 && (
        <div className={cx("mt-0.5", DS.text.empty)}>Left blank</div>
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
 * A question the agent asked, shown the way its form looked, with what was picked marked. The
 * question itself is the agent speaking, so it reads as content; the form below it is the answer.
 */
export function AskUserRecordView({ toolCall, record, variant = "transcript", waiting = false }: AskUserRecordViewProps) {
  const durationMs = getToolDurationMs(toolCall);
  const time = formatTime(toolCall.startedAt);
  const outcome = describeOutcome(record.outcome, durationMs);
  const showForm = record.fields.length > 0 || record.freeformAnswer;

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
      {showForm && (
        <div
          className={variant === "detail"
            ? "mt-2.5 space-y-3 border-l border-border pl-3"
            : cx("mt-2.5 space-y-3 px-3 py-2.5", DS.surface.inset)}
        >
          {record.fields.map((field) => (
            <FieldAnswer key={field.key || "answer"} field={field} outcome={record.outcome} />
          ))}
          {record.freeformAnswer && (
            <div className="min-w-0">
              {record.fields.length === 0 && <div className={DS.text.sectionLabel}>Your answer</div>}
              <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
                {record.freeformAnswer}
              </div>
            </div>
          )}
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
