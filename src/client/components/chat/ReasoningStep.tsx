import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Sparkle } from "lucide-react";
import type { ChatReasoningEntry } from "../../api";

/** Thinking longer than this opens clamped, with the rest one click away. */
const CLAMP_CHARS = 560;
const CLAMP_LINES = 8;

export const THOUGHT_PROSE = [
  "chat-prose prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed text-text-muted",
  "prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:my-1.5 prose-headings:text-[13px]",
  "prose-strong:font-medium prose-strong:text-text-secondary prose-headings:text-text-secondary",
  "prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-bg-surface prose-pre:p-2.5 prose-pre:text-xs",
  "prose-code:text-xs prose-a:text-text-secondary",
].join(" ");

function isLongThought(content: string): boolean {
  return content.length > CLAMP_CHARS || content.split(/\r?\n/).length > CLAMP_LINES;
}

interface ReasoningStepProps {
  entry: ChatReasoningEntry;
}

/** One block of the model's thinking inside an opened activity timeline. */
export default memo(function ReasoningStep({ entry }: ReasoningStepProps) {
  const streaming = entry.reasoning.streaming === true;
  const long = isLongThought(entry.content);
  const [showAll, setShowAll] = useState(false);
  // Streaming text is shown whole: the reader opened the timeline to watch it arrive.
  const clamped = long && !showAll && !streaming;

  return (
    <div className="flex min-w-0 gap-2 py-1.5" data-thought-state={streaming ? "streaming" : "done"}>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        <Sparkle size={12} className={streaming ? "animate-pulse text-text-muted" : "text-text-faint"} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        {streaming ? (
          // Still arriving: plain text is cheap to repaint many times a second, and half-written
          // markdown would flicker between readings. It is formatted once it is complete.
          <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-muted" aria-busy="true">
            {entry.content}
          </div>
        ) : (
          <div className={`${THOUGHT_PROSE} ${clamped ? "chat-thought-clamp max-h-40 overflow-hidden" : ""}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{entry.content}</ReactMarkdown>
          </div>
        )}
        {long && !streaming && (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            aria-expanded={showAll}
            className="mt-1 cursor-pointer text-xs text-text-faint underline-offset-2 transition-colors hover:text-text-secondary hover:underline focus-visible:outline-none focus-visible:text-text-secondary"
          >
            {showAll ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
});
