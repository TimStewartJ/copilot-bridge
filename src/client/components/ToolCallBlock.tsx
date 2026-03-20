import { useState, memo } from "react";
import type { ToolCall } from "../api";

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
    <div className="border border-gray-700/50 rounded-md text-xs font-mono overflow-hidden">
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${hasDetails ? "hover:bg-gray-700/30 cursor-pointer" : "cursor-default"} transition-colors`}
      >
        <span className="text-indigo-400/60 shrink-0">
          {toolCall.success === false ? "❌" : "⚙️"}
        </span>
        <span className="text-indigo-300 shrink-0">{toolCall.name}</span>
        {summary && (
          <span className="text-gray-500 truncate">{summary}</span>
        )}
        {hasDetails && (
          <span className="text-gray-600 ml-auto shrink-0">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-gray-700/50 px-2.5 py-2 space-y-2">
          {toolCall.args && Object.keys(toolCall.args).length > 0 && (
            <div>
              <div className="text-gray-500 mb-1">Arguments</div>
              <pre className="text-gray-400 whitespace-pre-wrap break-all text-[11px] max-h-32 overflow-auto">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-gray-500 mb-1">Result</div>
              <pre className="text-gray-400 whitespace-pre-wrap break-all text-[11px] max-h-64 overflow-auto">
                {toolCall.result!.length > 2000 ? toolCall.result!.slice(0, 2000) + "\n... (truncated)" : toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
