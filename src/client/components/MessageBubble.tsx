import { memo } from "react";
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
}

function renderToolCalls(toolCalls: NonNullable<ChatMessage["toolCalls"]>) {
  const { roots } = buildToolCallForest(toolCalls);
  return roots.map((node) => (
    <ToolCallTree key={node.toolCall.toolCallId} node={node} />
  ));
}

export default memo(function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    const hasAttachments = message.attachments && message.attachments.length > 0;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-4 py-3 bg-accent text-white rounded-2xl rounded-br-sm text-sm leading-relaxed whitespace-pre-wrap break-words">
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
                      className="max-w-[200px] max-h-[200px] rounded-md border border-white/20 cursor-pointer hover:opacity-90 transition-opacity"
                    />
                  </a>
                ) : (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-md bg-white/10 text-white/90 text-xs max-w-[200px]">
                    <FileText size={14} className="flex-shrink-0 text-white/60" />
                    <span className="truncate">{att.displayName ?? "file"}</span>
                  </div>
                ),
              )}
            </div>
          )}
          {message.content !== "(image)" && message.content !== "(attachment)" && message.content}
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
          {renderToolCalls(message.toolCalls!)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start min-w-0">
      <div className="max-w-[85%] min-w-0 break-words space-y-2">
        {hasContent && (
          <div className={`px-4 py-3 bg-bg-surface text-text-primary rounded-2xl rounded-bl-sm text-sm leading-relaxed ${APP_PROSE} prose-pre:bg-bg-primary prose-th:bg-bg-primary`}>
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
              {message.content}
            </ReactMarkdown>
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
