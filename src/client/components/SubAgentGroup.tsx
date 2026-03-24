import { useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { ToolCall } from "../api";
import ToolCallBlock from "./ToolCallBlock";
import { Bot, ChevronDown, ChevronRight, XCircle } from "lucide-react";

interface SubAgentGroupProps {
  agentTool: ToolCall;
  childTools: ToolCall[];
}

export default memo(function SubAgentGroup({ agentTool, childTools }: SubAgentGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const agentLabel = agentTool.name.replace(/^🤖\s*/, "");
  const childCount = childTools.length;
  const failed = agentTool.success === false;
  const hasResult = agentTool.result && agentTool.result.trim().length > 0;
  const hasContent = childCount > 0 || hasResult;

  return (
    <div className="border border-border rounded-md text-xs font-mono overflow-hidden">
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${hasContent ? "hover:bg-bg-hover cursor-pointer" : "cursor-default"} transition-colors`}
      >
        <span className="shrink-0">
          {failed
            ? <XCircle size={12} className="text-error" />
            : <Bot size={12} className="text-purple-400" />
          }
        </span>
        <span className="text-purple-400 shrink-0">{agentLabel}</span>
        {childCount > 0 && (
          <span className="text-text-faint">
            {childCount} tool{childCount !== 1 ? "s" : ""}
          </span>
        )}
        {hasContent && (
          <span className="text-text-faint ml-auto shrink-0">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border">
          {childTools.length > 0 && (
            <div className="pl-3 pr-1 py-1.5 space-y-1 border-l-2 border-l-purple-400/30 ml-2 mr-1 mb-1">
              {childTools.map((tc) => (
                <ToolCallBlock key={tc.toolCallId} toolCall={tc} />
              ))}
            </div>
          )}
          {hasResult && (
            <div className="px-2.5 py-2 border-t border-border">
              <div className="text-text-muted mb-1 text-[11px]">Response</div>
              <div className="text-text-secondary text-xs leading-relaxed prose prose-invert prose-xs prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-headings:mt-2 prose-headings:mb-1 prose-pre:bg-bg-primary prose-pre:rounded prose-pre:p-2 prose-pre:text-[11px] prose-code:text-accent prose-code:text-[11px] max-h-64 overflow-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {agentTool.result!.length > 5000 ? agentTool.result!.slice(0, 5000) + "\n\n... (truncated)" : agentTool.result!}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
