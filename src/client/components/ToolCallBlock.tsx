import { useEffect, useRef, useState, memo, useMemo, type ReactNode } from "react";
import { ChevronRight, CircleAlert, Loader2 } from "lucide-react";
import type { ToolArgs, ToolCall } from "../api";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import ToolResultModal from "./ToolResultModal";
import ToolIcon from "./chat/ToolIcon";
import { useChatRunActive } from "./chat/chat-run-context";
import { formatToolArgsDetails, hasToolArgs } from "../lib/tool-args";
import { getToolCallStatus, getToolCallStatusLabel } from "../lib/tool-call-status";
import { describeToolCall, formatDuration, getToolDurationMs } from "../lib/tool-presentation";

const RESULT_PREVIEW_CHARS = 2000;

/**
 * A shell command or SQL query is easier to read as itself than as an escaped JSON string, so it
 * gets its own section and only the remaining arguments are shown as JSON.
 */
function splitPrimaryInput(args: ToolArgs | undefined): {
  primary?: { label: string; text: string };
  rest: ToolArgs | undefined;
} {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { rest: args };
  const key = typeof args.command === "string" && args.command.trim()
    ? "command"
    : typeof args.query === "string" && args.query.includes("\n")
      ? "query"
      : undefined;
  if (!key) return { rest: args };
  const { [key]: text, description: _description, ...rest } = args;
  return {
    primary: { label: key === "command" ? "Command" : "Query", text: text as string },
    rest: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

function formatStartTime(tc: ToolCall): string | null {
  if (!tc.startedAt) return null;
  const start = new Date(tc.startedAt);
  if (Number.isNaN(start.getTime())) return null;
  return start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface ToolCallBlockProps {
  toolCall: ToolCall;
  childNodes?: ToolCallTreeNode[];
  renderChildNodes?: (childNodes: ToolCallTreeNode[]) => ReactNode;
  defaultExpanded?: boolean;
  contextOnly?: boolean;
}

function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-sans text-[10px] font-medium uppercase tracking-wider text-text-faint">{label}</div>
      {children}
    </div>
  );
}

const DETAIL_PRE_CLASS = "chat-scroll overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary";

/** One tool call as a quiet sentence; the raw name, arguments and result open beneath it. */
export default memo(function ToolCallBlock({ toolCall, childNodes = [], renderChildNodes, defaultExpanded = false, contextOnly = false }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded && childNodes.length > 0);
  const [showFullModal, setShowFullModal] = useState(false);
  const autoExpandedRef = useRef(defaultExpanded && childNodes.length > 0);
  const runActive = useChatRunActive();
  const progressText = toolCall.progressText?.trim();
  const result = toolCall.result?.trim() ? toolCall.result : undefined;
  const hasDetails = Boolean(result) || hasToolArgs(toolCall.args) || !!progressText || childNodes.length > 0;
  const status = useMemo(
    () => contextOnly ? null : getToolCallStatus(toolCall),
    [contextOnly, toolCall.completedAt, toolCall.result, toolCall.success],
  );
  // No completion was recorded and the run is over: it never finished, which is not "running".
  const unfinished = status === "running" && !runActive;
  const presentation = useMemo(
    () => describeToolCall(toolCall, unfinished ? "done" : status),
    [status, toolCall.args, toolCall.isSubAgent, toolCall.name, unfinished],
  );
  const durationMs = getToolDurationMs(toolCall);
  const startTime = formatStartTime(toolCall);
  const input = useMemo(() => splitPrimaryInput(toolCall.args), [toolCall.args]);
  const running = status === "running" && runActive;
  const failed = status === "failed";

  useEffect(() => {
    if (!defaultExpanded || autoExpandedRef.current || childNodes.length === 0) return;
    setExpanded(true);
    autoExpandedRef.current = true;
  }, [defaultExpanded, childNodes.length]);

  return (
    <div className="min-w-0 text-[13px]" data-tool-status={unfinished ? "unfinished" : status ?? "context"}>
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        aria-expanded={hasDetails ? expanded : undefined}
        title={toolCall.name}
        className={`group/tool -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
          hasDetails ? "cursor-pointer hover:bg-bg-hover/60" : "cursor-default"
        }`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {running
            ? <Loader2 size={13} className="animate-spin text-text-muted" aria-label={getToolCallStatusLabel("running")} />
            : failed
              ? <CircleAlert size={13} className="text-error" aria-label={getToolCallStatusLabel("failed")} />
              : <ToolIcon name={presentation.icon} size={13} className="text-text-faint" />}
        </span>
        {/* The label keeps its width; the target takes whatever is left and truncates first. */}
        <span className={`min-w-0 shrink truncate ${running ? "shimmer-text" : failed ? "text-error" : "text-text-secondary"}`}>
          {presentation.verb}
        </span>
        {(presentation.target || (running && progressText)) && (
          <span
            className={`min-w-0 flex-1 truncate text-text-muted ${
              presentation.target && presentation.mono ? "font-mono text-[12px]" : ""
            }`}
          >
            {presentation.target ?? progressText}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] tabular-nums text-text-faint">
          {childNodes.length > 0 && (
            <span>{childNodes.length} step{childNodes.length === 1 ? "" : "s"}</span>
          )}
          {unfinished && <span>did not finish</span>}
          {durationMs !== undefined && durationMs >= 1000 && <span>{formatDuration(durationMs)}</span>}
          {hasDetails && (
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </span>
      </button>
      {expanded && (
        <div className="mb-2 ml-6 mt-1 space-y-2.5 rounded-lg border border-border-subtle bg-bg-secondary/70 p-2.5">
          <div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-text-faint">
            <span className="text-text-muted">{toolCall.name}</span>
            {startTime && <span>{startTime}</span>}
            {durationMs !== undefined && <span>{formatDuration(durationMs)}</span>}
          </div>
          {/* Progress is what a call has said so far; once it has a result, that says it better. */}
          {progressText && !result && (
            <DetailSection label="Latest progress">
              <pre className={`${DETAIL_PRE_CLASS} max-h-32`}>{progressText}</pre>
            </DetailSection>
          )}
          {input.primary && (
            <DetailSection label={input.primary.label}>
              <pre className={`${DETAIL_PRE_CLASS} max-h-40`}>{input.primary.text}</pre>
            </DetailSection>
          )}
          {hasToolArgs(input.rest) && (
            <DetailSection label="Arguments">
              <pre className={`${DETAIL_PRE_CLASS} max-h-40`}>{formatToolArgsDetails(input.rest)}</pre>
            </DetailSection>
          )}
          {result && (
            <DetailSection label="Result">
              <pre className={`${DETAIL_PRE_CLASS} max-h-64`}>
                {result.length > RESULT_PREVIEW_CHARS ? `${result.slice(0, RESULT_PREVIEW_CHARS)}\n... (truncated)` : result}
              </pre>
              {result.length > RESULT_PREVIEW_CHARS && (
                <button
                  type="button"
                  onClick={() => setShowFullModal(true)}
                  className="mt-1.5 cursor-pointer text-[11px] text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
                >
                  Show full response
                </button>
              )}
            </DetailSection>
          )}
          {childNodes.length > 0 && renderChildNodes && (
            <div className="border-l border-border pl-3">
              {renderChildNodes(childNodes)}
            </div>
          )}
        </div>
      )}
      {showFullModal && result && (
        <ToolResultModal
          title={toolCall.name}
          content={result}
          onClose={() => setShowFullModal(false)}
        />
      )}
    </div>
  );
});
