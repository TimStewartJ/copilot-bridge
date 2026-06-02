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

export default function CompletionCard({ entry }: CompletionCardProps) {
  const isError = entry.completion.status === "error";
  const Icon = isError ? AlertTriangle : CheckCircle2;
  const toneClass = isError
    ? "border-error/30 bg-error/10 text-error"
    : "border-success/30 bg-success/10 text-success";

  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm ${toneClass}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em]">
        <Icon size={14} className="shrink-0" />
        <span>{entry.completion.title}</span>
      </div>
      <div className={`mt-2 text-sm leading-relaxed text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface`}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
          {entry.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
