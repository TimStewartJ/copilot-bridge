import { useState, memo } from "react";
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

  return (
    <div className="border border-border rounded-md text-xs font-mono overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover cursor-pointer transition-colors"
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
        <span className="text-text-faint ml-auto shrink-0">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {expanded && childTools.length > 0 && (
        <div className="border-t border-border pl-3 pr-1 py-1.5 space-y-1 border-l-2 border-l-purple-400/30 ml-2 mr-1 mb-1">
          {childTools.map((tc) => (
            <ToolCallBlock key={tc.toolCallId} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
});
