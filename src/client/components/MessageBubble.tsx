import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { ChatMessage } from "../api";
import ToolCallBlock from "./ToolCallBlock";

interface MessageBubbleProps {
  message: ChatMessage;
}

export default memo(function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-4 py-3 bg-accent text-white rounded-2xl rounded-br-sm text-sm leading-relaxed whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  const hasContent = message.content.trim().length > 0;
  const hasTools = message.toolCalls && message.toolCalls.length > 0;

  // Tool-only message (no text) — render compact tool blocks
  if (!hasContent && hasTools) {
    return (
      <div className="flex justify-start min-w-0">
        <div className="max-w-[85%] min-w-0 space-y-1">
          {message.toolCalls!.map((tc) => (
            <ToolCallBlock key={tc.toolCallId} toolCall={tc} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start min-w-0">
      <div className="max-w-[85%] min-w-0 break-words space-y-2">
        {hasContent && (
          <div className="px-4 py-3 bg-bg-surface text-text-primary rounded-2xl rounded-bl-sm text-sm leading-relaxed prose prose-invert prose-sm
            prose-pre:bg-bg-primary prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full
            prose-code:text-accent prose-code:text-xs prose-code:font-mono
            prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-1.5 prose-th:bg-bg-primary
            prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5
            prose-table:block prose-table:overflow-x-auto prose-table:max-w-full
            prose-a:text-accent prose-a:no-underline hover:prose-a:underline
            prose-headings:mt-3 prose-headings:mb-1
            prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
            prose-li:my-0.5">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {hasTools && (
          <div className="space-y-1">
            {message.toolCalls!.map((tc) => (
              <ToolCallBlock key={tc.toolCallId} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
