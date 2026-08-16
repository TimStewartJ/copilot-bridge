import { useEffect, useRef, useState, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { ToolArgs, ToolCall } from "../api";
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

function getStringArg(args: ToolArgs | undefined, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeInstruction(content: string): string {
  return content.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
}

export default memo(function SubAgentGroup({ agentTool, childNodes = [], renderChildNodes, defaultExpanded = false, contextOnly = false }: SubAgentGroupProps) {
  const agentLabel = agentTool.name.replace(/^🤖\s*/, "");
  const childCount = childNodes.length;
  const progressText = agentTool.progressText?.trim();
  const hasResult = agentTool.result && agentTool.result.trim().length > 0;
  const instructions = agentTool.agentInstructions ?? [];
  const taskDescription = getStringArg(agentTool.args, "description")
    ?? (instructions[0] ? summarizeInstruction(instructions[0].content) : undefined);
  const headerSummary = taskDescription && progressText
    ? `${taskDescription} · ${progressText}`
    : taskDescription ?? progressText;
  const hasContent = childCount > 0 || hasResult || !!progressText || instructions.length > 0;
  const [expanded, setExpanded] = useState(defaultExpanded && hasContent);
  const [showFullModal, setShowFullModal] = useState(false);
  const autoExpandedRef = useRef(defaultExpanded && hasContent);

  useEffect(() => {
    if (!defaultExpanded || autoExpandedRef.current || !hasContent) return;
    setExpanded(true);
    autoExpandedRef.current = true;
  }, [defaultExpanded, hasContent]);

  return (
    <div className="border border-border rounded-md text-xs font-mono overflow-hidden">
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        aria-expanded={hasContent ? expanded : undefined}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${hasContent ? "hover:bg-bg-hover cursor-pointer" : "cursor-default"} transition-colors`}
      >
        <span className="shrink-0">
          <Bot size={12} className="text-agent" />
        </span>
        <span className="text-agent shrink-0">{agentLabel}</span>
        {headerSummary && (
          <span className="min-w-0 truncate text-text-muted" title={headerSummary}>
            {headerSummary}
          </span>
        )}
        {childCount > 0 && (
          <span className="ml-auto shrink-0 text-text-faint">
            {childCount} tool{childCount !== 1 ? "s" : ""}
          </span>
        )}
        <span className={`${childCount > 0 ? "" : "ml-auto"} flex shrink-0 items-center gap-2`}>
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
          {instructions.length > 0 && (
            <div className="max-h-72 overflow-auto border-b border-border">
              {instructions.map((instruction, index) => (
                <div
                  key={`${instruction.kind}-${index}`}
                  className={index > 0 ? "border-t border-border/60 px-2.5 py-2" : "px-2.5 py-2"}
                >
                  <div className="mb-1 text-[11px] text-text-muted">
                    {instruction.kind === "task" ? "Task delegated by Copilot" : "Follow-up from Copilot"}
                  </div>
                  <div className="prose prose-invert prose-xs max-w-none text-xs leading-relaxed text-text-secondary prose-headings:mb-1 prose-headings:mt-2 prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-pre:rounded prose-pre:bg-bg-primary prose-pre:p-2 prose-pre:text-[11px] prose-code:text-[11px] prose-code:text-accent">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {instruction.content}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
            </div>
          )}
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
