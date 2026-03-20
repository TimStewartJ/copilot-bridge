import { useState, memo } from "react";
import type { ToolCall } from "../api";
import { Settings, XCircle, ChevronDown, ChevronRight } from "lucide-react";

interface ToolCallBlockProps {
  toolCall: ToolCall;
}

function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (key === "intent") continue;
    const s = typeof val === "string" ? val : JSON.stringify(val);
    parts.push(s.length > 80 ? s.slice(0, 77) + "..." : s);
  }
  return parts.join("  ");
}

function argSummary(tc: ToolCall): string {
  if (!tc.args || Object.keys(tc.args).length === 0) return "";
  // For common tools, show the most useful arg
  const a = tc.args;
  if (a.path) return String(a.path).replace(/\\/g, "/").split("/").slice(-3).join("/");
  if (a.pattern) return String(a.pattern);
  if (a.command) return String(a.command).slice(0, 60);
  if (a.query) return String(a.query).slice(0, 60);
  if (a.prompt) return String(a.prompt).slice(0, 60);
  if (a.url) return String(a.url).slice(0, 60);
  return formatArgs(a);
}

export default memo(function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = argSummary(toolCall);
  const hasResult = toolCall.result && toolCall.result.trim().length > 0;
  const hasDetails = hasResult || (toolCall.args && Object.keys(toolCall.args).length > 0);

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
          {toolCall.args && Object.keys(toolCall.args).length > 0 && (
            <div>
              <div className="text-text-muted mb-1">Arguments</div>
              <pre className="text-text-muted whitespace-pre-wrap break-all text-[11px] max-h-32 overflow-auto">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-text-muted mb-1">Result</div>
              <pre className="text-text-muted whitespace-pre-wrap break-all text-[11px] max-h-64 overflow-auto">
                {toolCall.result!.length > 2000 ? toolCall.result!.slice(0, 2000) + "\n... (truncated)" : toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
