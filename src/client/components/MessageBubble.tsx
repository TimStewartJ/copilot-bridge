import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { FileText } from "lucide-react";
import type { ChatMessage } from "../api";
import { buildToolCallForest } from "../lib/tool-call-tree";
import ToolCallTree from "./ToolCallTree";
import CodeBlock from "./CodeBlock";
import { APP_PROSE } from "./shared/prose-classes";

interface MessageBubbleProps {
  message: ChatMessage;
  actionSlot?: ReactNode;
  isStreaming?: boolean;
}

function BubbleActions({ side, children }: { side: "left" | "right"; children?: ReactNode }) {
  if (!children) return null;
  return (
    <div
      className={`pointer-events-none absolute -top-3 z-10 opacity-0 transition-opacity group-hover/message-bubble:opacity-100 group-focus-within/message-bubble:opacity-100 ${
        side === "right" ? "right-1" : "left-1"
      }`}
    >
      <div className="pointer-events-auto inline-flex overflow-hidden rounded-full border border-border bg-bg-secondary/95 text-text-muted shadow-sm backdrop-blur">
        {children}
      </div>
    </div>
  );
}

function renderToolCalls(toolCalls: NonNullable<ChatMessage["toolCalls"]>) {
  const { roots } = buildToolCallForest(toolCalls);
  return roots.map((node) => (
    <ToolCallTree key={node.toolCall.toolCallId} node={node} />
  ));
}

export default memo(function MessageBubble({ message, actionSlot, isStreaming = false }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    const hasAttachments = message.attachments && message.attachments.length > 0;
    return (
      <div className="flex justify-end">
        <div className="group/message-bubble relative max-w-[85%] sm:max-w-[78%] md:max-w-[72%]">
          <BubbleActions side="right">{actionSlot}</BubbleActions>
          <div className="rounded-2xl rounded-br-sm border border-accent-border bg-accent-surface px-4 py-3 text-sm leading-relaxed text-text-primary shadow-sm whitespace-pre-wrap break-words">
            {hasAttachments && (
              <div className="flex gap-2 flex-wrap mb-2">
                {message.attachments!.map((att, i) =>
                  att.type === "blob" && att.mimeType.startsWith("image/") ? (
                    <a
                      key={i}
                      href={`data:${att.mimeType};base64,${att.data}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={att.displayName ?? "Click to view full size"}
                    >
                      <img
                        src={`data:${att.mimeType};base64,${att.data}`}
                        alt={att.displayName ?? "attachment"}
                        className="max-w-[200px] max-h-[200px] rounded-md border border-border cursor-pointer hover:opacity-90 transition-opacity"
                      />
                    </a>
                  ) : (
                    <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-surface text-text-secondary text-xs max-w-[200px]">
                      <FileText size={14} className="flex-shrink-0 text-text-faint" />
                      <span className="truncate">{att.displayName ?? "file"}</span>
                    </div>
                  ),
                )}
              </div>
            )}
            {message.content !== "(image)" && message.content !== "(attachment)" && message.content}
          </div>
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
        <div className="group/message-bubble relative w-full max-w-full min-w-0 space-y-1">
          <BubbleActions side="left">{actionSlot}</BubbleActions>
          {renderToolCalls(message.toolCalls!)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start min-w-0">
      <div className="group/message-bubble relative w-full max-w-full min-w-0 break-words space-y-2">
        <BubbleActions side="left">{actionSlot}</BubbleActions>
        {hasContent && (
          <div
            className={`max-w-none py-1 text-sm leading-relaxed text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface prose-th:bg-bg-surface`}
            aria-busy={isStreaming || undefined}
          >
            <div className={isStreaming ? "streaming-text-fade" : undefined}>
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {hasTools && (
          <div className="space-y-1">
            {renderToolCalls(message.toolCalls!)}
          </div>
        )}
      </div>
    </div>
  );
});
