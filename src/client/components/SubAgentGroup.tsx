import { useEffect, useRef, useState, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Bot, ChevronRight, CircleAlert, Loader2 } from "lucide-react";
import type { ToolArgs, ToolCall } from "../api";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import { getToolCallStatus, getToolCallStatusLabel } from "../lib/tool-call-status";
import { formatDuration, getToolDurationMs } from "../lib/tool-presentation";
import ToolResultModal from "./ToolResultModal";
import { useChatRunActive } from "./chat/chat-run-context";
import { DS, cx } from "../design/tokens";

const RESPONSE_PREVIEW_CHARS = 5000;

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

const AGENT_PROSE = "ds-prose prose prose-invert prose-xs max-w-none text-xs leading-relaxed text-text-secondary prose-headings:mb-1 prose-headings:mt-2 prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-pre:rounded prose-pre:bg-bg-primary prose-pre:p-2 prose-pre:text-[11px] prose-code:text-[11px]";

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className={cx("mb-1", DS.text.eyebrow)}>{children}</div>
  );
}

/** A delegated agent: one row that opens onto its brief, its own tool calls and its answer. */
export default memo(function SubAgentGroup({ agentTool, childNodes = [], renderChildNodes, defaultExpanded = false, contextOnly = false }: SubAgentGroupProps) {
  const agentLabel = agentTool.name.replace(/^🤖\s*/, "");
  const childCount = childNodes.length;
  const result = agentTool.result?.trim() ? agentTool.result : undefined;
  // Progress is what the agent has said so far; once it has answered, the answer says it better.
  const progressText = result ? undefined : agentTool.progressText?.trim();
  const instructions = agentTool.agentInstructions ?? [];
  const taskDescription = getStringArg(agentTool.args, "description")
    ?? (instructions[0] ? summarizeInstruction(instructions[0].content) : undefined);
  const headerSummary = taskDescription && progressText
    ? `${taskDescription} · ${progressText}`
    : taskDescription ?? progressText;
  const hasContent = childCount > 0 || Boolean(result) || !!progressText || instructions.length > 0;
  const [expanded, setExpanded] = useState(defaultExpanded && hasContent);
  const [showFullModal, setShowFullModal] = useState(false);
  const autoExpandedRef = useRef(defaultExpanded && hasContent);
  const status = contextOnly ? null : getToolCallStatus(agentTool);
  const runActive = useChatRunActive();
  // An agent with no recorded completion in a run that is over never finished; it is not running.
  const unfinished = status === "running" && !runActive;
  const running = status === "running" && runActive;
  const failed = status === "failed";
  const durationMs = getToolDurationMs(agentTool);
  // Failures inside an agent are invisible until its row is opened, so the row has to say so.
  const failedInside = childNodes.reduce((sum, child) => sum + child.failedCount, 0);

  useEffect(() => {
    if (!defaultExpanded || autoExpandedRef.current || !hasContent) return;
    setExpanded(true);
    autoExpandedRef.current = true;
  }, [defaultExpanded, hasContent]);

  return (
    <div className="min-w-0 text-[13px]" data-tool-status={unfinished ? "unfinished" : status ?? "context"}>
      <button
        type="button"
        onClick={() => hasContent && setExpanded(!expanded)}
        aria-expanded={hasContent ? expanded : undefined}
        className={cx(DS.row.base, hasContent ? DS.row.interactive : DS.row.inert)}
      >
        <span className={DS.row.iconSlot}>
          {running
            ? <Loader2 size={13} className="animate-spin text-agent" aria-label={getToolCallStatusLabel("running")} />
            : failed
              ? <CircleAlert size={13} className="text-error" aria-label={getToolCallStatusLabel("failed")} />
              : <Bot size={13} className="text-agent" aria-hidden="true" />}
        </span>
        <span className={`shrink-0 font-medium ${failed ? "text-error" : "text-text-secondary"}`}>{agentLabel}</span>
        {headerSummary && (
          <span className="min-w-0 truncate text-text-muted" title={headerSummary}>
            {headerSummary}
          </span>
        )}
        <span className={DS.row.trailing}>
          {childCount > 0 && <span>{childCount} tool{childCount !== 1 ? "s" : ""}</span>}
          {failedInside > 0 && <span className="text-error/80">{failedInside} failed</span>}
          {unfinished && <span>did not finish</span>}
          {durationMs !== undefined && durationMs >= 1000 && <span>{formatDuration(durationMs)}</span>}
          {hasContent && (
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={cx(DS.row.chevron, expanded && DS.row.chevronOpen)}
            />
          )}
        </span>
      </button>
      {expanded && (
        <div className="mb-2 ml-[7px] mt-1 space-y-3 border-l pl-4" style={{ borderLeftColor: "var(--color-agent-border)" }}>
          {instructions.length > 0 && (
            <div className="max-h-72 space-y-2 overflow-auto">
              {instructions.map((instruction, index) => (
                <div key={`${instruction.kind}-${index}`}>
                  <SectionLabel>
                    {instruction.kind === "task" ? "Task delegated by Copilot" : "Follow-up from Copilot"}
                  </SectionLabel>
                  <div className={AGENT_PROSE}>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {instruction.content}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
            </div>
          )}
          {progressText && (
            <div>
              <SectionLabel>Latest progress</SectionLabel>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">
                {progressText}
              </pre>
            </div>
          )}
          {childNodes.length > 0 && renderChildNodes && (
            <div>{renderChildNodes(childNodes)}</div>
          )}
          {result && (
            <div>
              <SectionLabel>Response</SectionLabel>
              <div className={`${AGENT_PROSE} max-h-64 overflow-auto`}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {result.length > RESPONSE_PREVIEW_CHARS ? `${result.slice(0, RESPONSE_PREVIEW_CHARS)}\n\n... (truncated)` : result}
                </ReactMarkdown>
              </div>
              {result.length > RESPONSE_PREVIEW_CHARS && (
                <button
                  type="button"
                  onClick={() => setShowFullModal(true)}
                  className="mt-1.5 cursor-pointer text-[11px] text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
                >
                  Show full response
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {showFullModal && result && (
        <ToolResultModal
          title={agentLabel}
          content={result}
          format="markdown"
          onClose={() => setShowFullModal(false)}
        />
      )}
    </div>
  );
});
