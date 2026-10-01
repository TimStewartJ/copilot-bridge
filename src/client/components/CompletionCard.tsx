import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ChatCompletionEntry } from "../api";
import { AutopilotBadge } from "../design/primitives";
import type { AutopilotRunSummary } from "../lib/autopilot-runs";
import { formatDuration } from "../lib/tool-presentation";
import CodeBlock from "./CodeBlock";
import { APP_PROSE } from "./shared/prose-classes";

interface CompletionCardProps {
  entry: ChatCompletionEntry;
  /** The autopilot run this completion ended, when its start is in the loaded transcript. */
  autopilot?: AutopilotRunSummary;
}

function describeAutopilotRun(run: AutopilotRunSummary): string {
  const parts = ["Autopilot"];
  if (run.turns !== undefined) parts.push(`${run.turns} turn${run.turns === 1 ? "" : "s"}`);
  if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs, { wholeSeconds: true }));
  return parts.join(" · ");
}

const SUMMARY_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const SUMMARY_MARKDOWN_COMPONENTS: Components = { pre: CodeBlock };

/** Parsed once per summary. The transcript renders again on every streamed chunk, and a summary can be long. */
const CompletionSummary = memo(function CompletionSummary({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={SUMMARY_REMARK_PLUGINS} components={SUMMARY_MARKDOWN_COMPONENTS}>
      {content}
    </ReactMarkdown>
  );
});

/** The run's closing summary. Only its marker carries colour; the summary reads as normal text. */
export default function CompletionCard({ entry, autopilot }: CompletionCardProps) {
  const isError = entry.completion.status === "error";
  const Icon = isError ? AlertTriangle : CheckCircle2;

  return (
    <div
      className={`rounded-xl border bg-bg-secondary/60 px-4 py-3 ${isError ? "border-error/30" : "border-border"}`}
      data-completion-status={isError ? "error" : "success"}
    >
      <div className={`flex items-center gap-1.5 text-xs font-medium ${isError ? "text-error" : "text-success"}`}>
        <Icon size={14} className="shrink-0" aria-hidden="true" />
        <span>{entry.completion.title}</span>
        {autopilot && (
          <AutopilotBadge className="ml-auto" title="This run used Autopilot">
            {describeAutopilotRun(autopilot)}
          </AutopilotBadge>
        )}
      </div>
      <div className={`ds-prose mt-2 max-w-none text-sm leading-[1.7] text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface prose-th:bg-bg-surface`}>
        <CompletionSummary content={entry.content} />
      </div>
    </div>
  );
}
