import { useEffect, useRef, useState, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { ToolCall } from "../api";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import ToolStatusBadge from "./ToolStatusBadge";
import ToolResultModal from "./ToolResultModal";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";

interface SubAgentGroupProps {
  agentTool: ToolCall;
  childNodes?: ToolCallTreeNode[];
  renderChildNodes?: (childNodes: ToolCallTreeNode[]) => ReactNode;
  defaultExpanded?: boolean;
  contextOnly?: boolean;
}

export default memo(function SubAgentGroup({ agentTool, childNodes = [], renderChildNodes, defaultExpanded = false, contextOnly = false }: SubAgentGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded && childNodes.length > 0);
  const [showFullModal, setShowFullModal] = useState(false);
  const autoExpandedRef = useRef(defaultExpanded && childNodes.length > 0);
  const agentLabel = agentTool.name.replace(/^🤖\s*/, "");
  const childCount = childNodes.length;
  const progressText = agentTool.progressText?.trim();
  const hasResult = agentTool.result && agentTool.result.trim().length > 0;
  const hasContent = childCount > 0 || hasResult || !!progressText;

  useEffect(() => {
    if (!defaultExpanded || autoExpandedRef.current || childNodes.length === 0) return;
    setExpanded(true);
    autoExpandedRef.current = true;
  }, [defaultExpanded, childNodes.length]);

  return (
    <div className="border border-border rounded-md text-xs font-mono overflow-hidden">
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${hasContent ? "hover:bg-bg-hover cursor-pointer" : "cursor-default"} transition-colors`}
      >
        <span className="shrink-0">
          <Bot size={12} className="text-agent" />
        </span>
        <span className="text-agent shrink-0">{agentLabel}</span>
        {childCount > 0 && (
          <span className="text-text-faint">
            {childCount} tool{childCount !== 1 ? "s" : ""}
          </span>
        )}
        {progressText && (
          <span className="text-text-muted truncate">{progressText}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {!contextOnly && <ToolStatusBadge toolCall={agentTool} />}
          {hasContent && (
            <span className="text-text-faint">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border">
          {progressText && (
            <div className="px-2.5 py-2 border-b border-border">
              <div className="text-text-muted mb-1 text-[11px]">Latest progress</div>
              <pre className="text-text-muted whitespace-pre-wrap break-all text-[11px] max-h-32 overflow-auto">
                {progressText}
              </pre>
            </div>
          )}
          {childNodes.length > 0 && renderChildNodes && (
            <div className="pl-3 pr-1 py-1.5 space-y-1 border-l-2 ml-2 mr-1 mb-1" style={{ borderLeftColor: "var(--color-agent-border)" }}>
              {renderChildNodes(childNodes)}
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
              {agentTool.result!.length > 5000 && (
                <button
                  onClick={() => setShowFullModal(true)}
                  className="text-accent/70 hover:text-accent text-[11px] mt-1 cursor-pointer"
                >
                  Show full response
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {showFullModal && (
        <ToolResultModal
          title={agentLabel}
          content={agentTool.result!}
          format="markdown"
          onClose={() => setShowFullModal(false)}
        />
      )}
    </div>
  );
});
