import { useState, memo, useMemo } from "react";
import type { ToolCall } from "../api";
import { Settings, XCircle, ChevronDown, ChevronRight } from "lucide-react";
import ToolResultModal from "./ToolResultModal";
import { formatToolArgsDetails, hasToolArgs, summarizeToolArgs } from "../lib/tool-args";

function formatToolTime(tc: ToolCall): string | null {
  if (!tc.startedAt) return null;
  const start = new Date(tc.startedAt);
  const time = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (tc.completedAt) {
    const ms = new Date(tc.completedAt).getTime() - start.getTime();
    if (ms < 1000) return `${time} · ${ms}ms`;
    return `${time} · ${(ms / 1000).toFixed(1)}s`;
  }
  return time;
}

interface ToolCallBlockProps {
  toolCall: ToolCall;
}

export default memo(function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [showFullModal, setShowFullModal] = useState(false);
  const summary = summarizeToolArgs(toolCall.args);
  const hasResult = toolCall.result && toolCall.result.trim().length > 0;
  const hasDetails = hasResult || hasToolArgs(toolCall.args);
  const timeLabel = useMemo(() => formatToolTime(toolCall), [toolCall.startedAt, toolCall.completedAt]);

  return (
    <div className="border border-border rounded-md text-xs font-mono overflow-hidden">
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${hasDetails ? "hover:bg-bg-hover cursor-pointer" : "cursor-default"} transition-colors`}
      >
        <span className="text-text-muted shrink-0">
          {toolCall.success === false ? <XCircle size={12} className="text-error" /> : <Settings size={12} className="text-accent/60" />}
        </span>
        <span className="text-accent shrink-0">{toolCall.name}</span>
        {summary && (
          <span className="text-text-muted truncate">{summary}</span>
        )}
        {hasDetails && (
          <span className="text-text-faint ml-auto shrink-0">{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-2.5 py-2 space-y-2">
          {timeLabel && (
            <div className="text-text-faint text-[11px]">{timeLabel}</div>
          )}
          {hasToolArgs(toolCall.args) && (
            <div>
              <div className="text-text-muted mb-1">Arguments</div>
              <pre className="text-text-muted whitespace-pre-wrap break-all text-[11px] max-h-32 overflow-auto">
                {formatToolArgsDetails(toolCall.args)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-text-muted mb-1">Result</div>
              <pre className="text-text-muted whitespace-pre-wrap break-all text-[11px] max-h-64 overflow-auto">
                {toolCall.result!.length > 2000 ? toolCall.result!.slice(0, 2000) + "\n... (truncated)" : toolCall.result}
              </pre>
              {toolCall.result!.length > 2000 && (
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
          title={toolCall.name}
          content={toolCall.result!}
          onClose={() => setShowFullModal(false)}
        />
      )}
    </div>
  );
});
