import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { ChatMessage, ToolCall } from "../api";
import ToolCallBlock from "./ToolCallBlock";
import SubAgentGroup from "./SubAgentGroup";
import CodeBlock from "./CodeBlock";

interface MessageBubbleProps {
  message: ChatMessage;
}

/** Group tool calls: sub-agent parents absorb their children, top-level stays flat */
function groupToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const agentIds = new Set(
    toolCalls.filter((tc) => tc.isSubAgent).map((tc) => tc.toolCallId),
  );

  // Collect children that belong to a sub-agent (by parentToolCallId)
  const childrenByParent = new Map<string, ToolCall[]>();
  const childToolCallIds = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.parentToolCallId && agentIds.has(tc.parentToolCallId)) {
      const arr = childrenByParent.get(tc.parentToolCallId) ?? [];
      arr.push(tc);
      childrenByParent.set(tc.parentToolCallId, arr);
      childToolCallIds.add(tc.toolCallId);
    }
  }

  // Build result: top-level tools + sub-agent groups (with children attached)
  return toolCalls
    .filter((tc) => !childToolCallIds.has(tc.toolCallId))
    .map((tc) =>
      tc.isSubAgent
        ? { ...tc, childToolCalls: childrenByParent.get(tc.toolCallId) }
        : tc,
    );
}

function renderToolCalls(toolCalls: ToolCall[]) {
  const grouped = groupToolCalls(toolCalls);
  return grouped.map((tc) =>
    tc.isSubAgent ? (
      <SubAgentGroup key={tc.toolCallId} agentTool={tc} childTools={tc.childToolCalls ?? []} />
    ) : (
      <ToolCallBlock key={tc.toolCallId} toolCall={tc} />
    ),
  );
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
              {message.attachments!.map((att, i) => (
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
              ))}
            </div>
          )}
          {message.content !== "(image)" && message.content}
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
