import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ChatCompletionEntry } from "../api";
import CodeBlock from "./CodeBlock";
import { APP_PROSE } from "./shared/prose-classes";

interface CompletionCardProps {
  entry: ChatCompletionEntry;
}

/** The run's closing summary. Only its marker carries colour; the summary reads as normal text. */
export default function CompletionCard({ entry }: CompletionCardProps) {
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
      </div>
      <div className={`chat-prose mt-2 max-w-none text-sm leading-[1.7] text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface prose-th:bg-bg-surface`}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
          {entry.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
