import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ChatCompletionEntry } from "../api";
import { AutopilotBadge, Button } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { verificationAnchorId } from "../lib/verification-record";
import { VerificationStatusBadge } from "./VerificationCard";
import type { AutopilotRunSummary } from "../lib/autopilot-runs";
import { formatDuration } from "../lib/tool-presentation";
import remarkWikilink from "../lib/remark-wikilink";
import { MESSAGE_MARKDOWN_COMPONENTS } from "./chat-markdown";
import { bridgeUrlTransform } from "./BridgeReference";
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

const SUMMARY_REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkWikilink];

/** Parsed once per summary. The transcript renders again on every streamed chunk, and a summary can be long. */
const CompletionSummary = memo(function CompletionSummary({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={SUMMARY_REMARK_PLUGINS} components={MESSAGE_MARKDOWN_COMPONENTS} urlTransform={bridgeUrlTransform}>
      {content}
    </ReactMarkdown>
  );
});

/** The run's closing summary. Only its marker carries colour; the summary reads as normal text. */
export default function CompletionCard({ entry, autopilot }: CompletionCardProps) {
  const isError = entry.completion.status === "error";
  const Icon = isError ? AlertTriangle : CheckCircle2;
  const verification = autopilot?.verification;

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
      {verification?.kind === "recorded" && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <VerificationStatusBadge status={verification.status} />
          <Button variant="ghost" aria-controls={verificationAnchorId(verification.toolCallId)} onClick={() => {
            const target = document.getElementById(verificationAnchorId(verification.toolCallId));
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({ block: "center" });
          }}>View evidence</Button>
        </div>
      )}
      {verification?.kind === "missing" && <p className={cx(DS.text.meta, "mt-2")}>No verification report recorded</p>}
      <div className={`ds-prose mt-2 max-w-none text-sm leading-[1.7] text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface prose-th:bg-bg-surface`}>
        <CompletionSummary content={entry.content} />
      </div>
    </div>
  );
}
