import { useEffect, useRef, useState, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Bot, ChevronRight, CircleAlert, Loader2 } from "lucide-react";
import type { ToolArgs, ToolCall } from "../api";
import { getTranscriptAgentActiveMs } from "../../shared/transcript-agents.js";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import { getToolCallStatus, getToolCallStatusLabel } from "../lib/tool-call-status";
import { formatDuration, getToolDurationMs } from "../lib/tool-presentation";
import { agentDisplayName } from "../lib/transcript-agents";
import { useNow } from "../hooks/useNow";
import ToolResultModal from "./ToolResultModal";
import { AGENT_PROSE } from "./shared/prose-classes";
import { useChatRunActive } from "./chat/chat-run-context";
import { useActivityBlockKey, useTranscriptAgents } from "./chat/transcript-agents-context";
import { DS, cx } from "../design/tokens";

const RESPONSE_PREVIEW_CHARS = 5000;

interface SubAgentGroupProps {
  agentTool: ToolCall;
  childNodes?: ToolCallTreeNode[];
  /** The agent's steps in everything that is loaded, in this stretch and the others. */
  loadedStepCount?: number;
  renderChildNodes?: (childNodes: ToolCallTreeNode[]) => ReactNode;
  defaultExpanded?: boolean;
  /**
   * The agent was launched in an earlier stretch of work, so this row holds only what it did in
   * this one. Its brief and its answer stay on the row where it was launched.
   */
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className={cx("mb-1", DS.text.eyebrow)}>{children}</div>
  );
}

/**
 * A delegated agent, as one row per stretch of work it took part in. The row where it was launched
 * opens onto its brief, what it did in that stretch and its answer, and carries the totals for its
 * whole run. A row in a later stretch opens onto what it did there.
 */
export default memo(function SubAgentGroup({ agentTool, childNodes = [], loadedStepCount = 0, renderChildNodes, defaultExpanded = false, contextOnly = false }: SubAgentGroupProps) {
  const agent = agentTool.agent;
  const agentLabel = agentDisplayName(agentTool);
  const runActive = useChatRunActive();
  const { latestBlockByAgent } = useTranscriptAgents();
  const blockKey = useActivityBlockKey();
  // An agent at work across several stretches has a row in each. Only the newest shows it working.
  const newestRow = blockKey === null
    || (latestBlockByAgent.get(agentTool.toolCallId) ?? blockKey) === blockKey;

  const result = !contextOnly && agentTool.result?.trim() ? agentTool.result : undefined;
  // Progress is what the agent has said so far; once it has answered, the answer says it better.
  const progressText = contextOnly || result ? undefined : agentTool.progressText?.trim();
  const instructions = contextOnly ? [] : agentTool.agentInstructions ?? [];
  const firstInstruction = agentTool.agentInstructions?.[0];
  const taskDescription = agent?.description
    ?? getStringArg(agentTool.args, "description")
    ?? (firstInstruction ? summarizeInstruction(firstInstruction.content) : undefined);
  const headerSummary = taskDescription && progressText
    ? `${taskDescription} · ${progressText}`
    : taskDescription ?? progressText;

  // A row for a later stretch has no call of its own; where it stands is where its agent does.
  const status = agent || !contextOnly ? getToolCallStatus(agentTool) : null;
  const running = status === "running" && runActive;
  const working = running && newestRow;
  // What became of the agent is said on the row that launched it and on the row where its work
  // ends. A row for a stretch in between only holds what was done there.
  const speaksForAgent = !contextOnly || newestRow;
  // No end was recorded and nothing can still end it: the session shut down or the run was cut short.
  const unfinished = speaksForAgent && (agent?.status === "stopped" || (status === "running" && !runActive));
  const failed = speaksForAgent && status === "failed";
  const rowStatus = !speaksForAgent ? "done" : unfinished ? "unfinished" : status ?? "context";

  // A background agent keeps working after the stretch that launched it, so its launch row counts
  // its whole run. Every other row counts what is beneath it.
  const wholeRunAgent = !contextOnly && agent?.background ? agent : undefined;
  const stepsHere = childNodes.length;
  const failedHere = childNodes.reduce((sum, child) => sum + child.failedCount, 0);
  // The records are read a moment after each step is taken; the steps already on screen count too,
  // so this row never trails the agent's row in the stretch it is working in.
  const stepCount = wholeRunAgent ? Math.max(wholeRunAgent.toolCount, loadedStepCount, stepsHere) : stepsHere;
  // Failures inside an agent are invisible until its row is opened, so the row has to say so.
  const failedCount = wholeRunAgent ? Math.max(wholeRunAgent.failedToolCount, failedHere) : failedHere;
  const stepsInLaterStretches = stepCount - stepsHere;

  const timed = !contextOnly;
  const now = useNow(timed && running && agent !== undefined);
  const durationMs = !timed
    ? undefined
    : agent
      ? getTranscriptAgentActiveMs(agent, running ? now : undefined) || getToolDurationMs(agentTool)
      : getToolDurationMs(agentTool);

  // A row that counts steps opens, if only to say which stretches they are in.
  const hasContent = stepCount > 0 || Boolean(result) || !!progressText || instructions.length > 0;
  const [expanded, setExpanded] = useState(defaultExpanded && hasContent);
  const [showFullModal, setShowFullModal] = useState(false);
  const autoExpandedRef = useRef(defaultExpanded && hasContent);

  useEffect(() => {
    if (!defaultExpanded || autoExpandedRef.current || !hasContent) return;
    setExpanded(true);
    autoExpandedRef.current = true;
  }, [defaultExpanded, hasContent]);

  return (
    <div
      className="min-w-0 text-[13px]"
      data-tool-status={rowStatus}
      data-agent-row={contextOnly ? "continued" : "launch"}
    >
      <button
        type="button"
        onClick={() => hasContent && setExpanded(!expanded)}
        aria-expanded={hasContent ? expanded : undefined}
        title={taskDescription}
        className={cx(DS.row.base, hasContent ? DS.row.interactive : DS.row.inert)}
      >
        <span className={DS.row.iconSlot}>
          {working
            ? <Loader2 size={13} className="animate-spin text-agent motion-reduce:animate-none" aria-label={getToolCallStatusLabel("running")} />
            : failed
              ? <CircleAlert size={13} className="text-error" aria-label={getToolCallStatusLabel("failed")} />
              : <Bot size={13} className="text-agent" aria-hidden="true" />}
        </span>
        {/* The name keeps its width; the brief takes whatever is left and truncates first. */}
        <span className={cx(DS.row.label, "font-medium", failed ? DS.tone.danger : "text-text-secondary")}>{agentLabel}</span>
        {headerSummary && (
          <span className={cx(DS.row.detail, "text-text-muted")}>{headerSummary}</span>
        )}
        <span className={DS.row.trailing}>
          {stepCount > 0 && <span>{plural(stepCount, "step")}</span>}
          {failedCount > 0 && <span className="text-error/80">{failedCount} failed</span>}
          {unfinished && <span>did not finish</span>}
          {durationMs !== undefined && durationMs >= 1000 && (
            <span>{formatDuration(durationMs, running ? { wholeSeconds: true } : {})}</span>
          )}
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
          {stepsInLaterStretches > 0 && (
            <p className={DS.text.meta} data-agent-later-steps={stepsInLaterStretches}>
              {stepsHere > 0
                ? `${plural(stepsInLaterStretches, "more step")} in the stretches of work that follow`
                : `${plural(stepsInLaterStretches, "step")}, in the stretches of work that follow`}
            </p>
          )}
          {result && (
            <div>
              <SectionLabel>{running ? "Latest update" : "Response"}</SectionLabel>
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
