import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolCall } from "../../api";
import {
  getReasoningHeadline,
  getReasoningTail,
  summarizeActivity,
  type ActivityBlock as ActivityBlockModel,
  type ActivityStep,
  type ActivitySummary,
} from "../../lib/chat-activity";
import { getToolCallStatus } from "../../lib/tool-call-status";
import { buildRenderableSegmentRoots, type ToolCallForest } from "../../lib/tool-call-tree";
import { describeToolCall, formatDuration } from "../../lib/tool-presentation";
import ToolCallNodeGroup from "../ToolCallNodeGroup";
import ReasoningStep from "./ReasoningStep";
import { useChatRunActive } from "./chat-run-context";
import { DS, cx } from "../../design/tokens";

interface ActivityBlockProps {
  block: ActivityBlockModel;
  toolForest: ToolCallForest;
  expanded: boolean;
  onToggle: (key: string, expanded: boolean) => void;
  /** The run is still going and this block is where its next step will land. */
  live?: boolean;
  /** What the agent says it is doing, shown while no single step is in flight. */
  liveLabel?: string;
}

interface HeaderText {
  label: string;
  detail?: string;
  detailMono?: boolean;
}

/** Re-render once a second while something is in flight, so its elapsed time keeps moving. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The newest few lines of thinking that is still arriving. It grows to three lines and then holds
 * that height, scrolling older text out of the top, so a long thought cannot push the page around.
 */
function ThoughtWindow({ content }: { content: string }) {
  const windowRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const tail = getReasoningTail(content);

  useLayoutEffect(() => {
    const frame = windowRef.current;
    const text = textRef.current;
    if (!frame || !text) return;
    // Only fade the top edge once text is actually leaving through it.
    setOverflowing(text.scrollHeight > frame.clientHeight + 1);
  }, [tail]);

  return (
    <div
      ref={windowRef}
      className={`ds-reveal ml-[5px] mt-1 flex max-h-[3.9rem] flex-col justify-end overflow-hidden border-l border-border pl-4 ${
        overflowing ? "chat-thought-window" : ""
      }`}
      aria-hidden="true"
      data-thought-window="true"
    >
      <p ref={textRef} className="shrink-0 text-[13px] leading-[1.3rem] text-text-muted">{tail}</p>
    </div>
  );
}

function getToolCalls(steps: ActivityStep[]): ToolCall[] {
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = [];
  for (const step of steps) {
    if (step.kind !== "tools") continue;
    for (const entry of step.entries) {
      if (seen.has(entry.toolCall.toolCallId)) continue;
      seen.add(entry.toolCall.toolCallId);
      toolCalls.push(entry.toolCall);
    }
  }
  return toolCalls;
}

function getStreamingThought(steps: ActivityStep[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === "reasoning" && step.entry.reasoning.streaming) return step.entry.content;
  }
  return undefined;
}

function agentLabel(toolCall: ToolCall): string {
  return toolCall.name.replace(/^🤖\s*/, "") || "Agent";
}

/**
 * The step in flight, for the collapsed line. Work inside a delegated agent is attributed to it:
 * an agent can run for minutes, so the line names the agent and what it is doing right now rather
 * than sitting on its brief. Calls an agent makes are its own business and are not counted as
 * other steps the reader is waiting on.
 */
function describeRunningStep(running: ToolCall[], toolForest: ToolCallForest): HeaderText {
  const parentAgent = (toolCall: ToolCall): ToolCall | undefined => {
    const parent = toolCall.parentToolCallId
      ? toolForest.nodesById.get(toolCall.parentToolCallId)?.toolCall
      : undefined;
    return parent?.isSubAgent ? parent : undefined;
  };
  const own = running.filter((toolCall) => !toolCall.parentToolCallId);
  const current = own[own.length - 1] ?? running[running.length - 1]!;
  const agent = current.isSubAgent ? current : parentAgent(current);
  // Agents still running whose launching call already returned (background agents) count too.
  const otherAgents = new Set(
    running.flatMap((toolCall) => {
      const owner = toolCall.isSubAgent ? toolCall : parentAgent(toolCall);
      return owner && owner.toolCallId !== agent?.toolCallId ? [owner.toolCallId] : [];
    }),
  );
  const others = own.filter((toolCall) => toolCall !== current && !toolCall.isSubAgent).length + otherAgents.size;
  const more = others > 0 ? `+${others} more` : undefined;

  if (!agent) {
    const presentation = describeToolCall(current, "running");
    return {
      label: presentation.verb,
      detail: [presentation.target, more].filter(Boolean).join("  ·  ") || undefined,
      detailMono: presentation.mono && !more,
    };
  }

  const step = current === agent
    ? [...running].reverse().find((toolCall) => toolCall.parentToolCallId === agent.toolCallId)
    : current;
  const stepText = step
    ? (() => {
        const presentation = describeToolCall(step, "running");
        return [presentation.verb, presentation.target].filter(Boolean).join(" ");
      })()
    : describeToolCall(agent, "running").target;
  return {
    label: agentLabel(agent),
    detail: [stepText, more].filter(Boolean).join("  ·  ") || undefined,
  };
}

function describeHeader(
  steps: ActivityStep[],
  summary: ActivitySummary,
  live: boolean,
  inFlight: boolean,
  liveLabel: string | undefined,
  toolForest: ToolCallForest,
): HeaderText {
  const toolCalls = getToolCalls(steps);
  if (inFlight && summary.streamingThought) return { label: "Thinking" };

  if (inFlight && summary.runningCount > 0) {
    const running = toolCalls.filter((toolCall) => getToolCallStatus(toolCall) === "running");
    return describeRunningStep(running, toolForest);
  }

  if (live) return { label: liveLabel?.trim() || "Working" };

  if (toolCalls.length === 0) {
    const first = steps.find((step) => step.kind === "reasoning");
    return {
      label: "Thought",
      detail: first?.kind === "reasoning" ? getReasoningHeadline(first.entry.content) || undefined : undefined,
    };
  }

  if (toolCalls.length === 1) {
    const only = toolCalls[0]!;
    const status = getToolCallStatus(only);
    // A lone call that never recorded a completion, in a run that is over, reads in the past tense.
    const presentation = describeToolCall(only, status === "running" ? "done" : status);
    return { label: presentation.verb, detail: presentation.target, detailMono: presentation.mono };
  }

  return {
    label: summary.durationMs !== undefined && summary.durationMs >= 1000
      ? `Worked for ${formatDuration(summary.durationMs)}`
      : "Worked",
  };
}

/**
 * Everything the agent did between two things it said, as one line that opens into a timeline of
 * its thinking and tool calls. While the run is live the line names the step in flight.
 */
export default memo(function ActivityBlock({
  block,
  toolForest,
  expanded,
  onToggle,
  live = false,
  liveLabel,
}: ActivityBlockProps) {
  const runActive = useChatRunActive();
  // Steps with no recorded end are in flight only while the run that owns them is still going.
  const inFlight = useMemo(() => {
    if (!runActive) return false;
    const snapshot = summarizeActivity(block.steps);
    return snapshot.runningCount > 0 || snapshot.streamingThought;
  }, [block.steps, runActive]);
  const active = live || inFlight;
  const now = useNow(active);
  const summary = useMemo(
    () => summarizeActivity(block.steps, active ? now : undefined),
    [active, block.steps, now],
  );
  const header = useMemo(
    () => describeHeader(block.steps, summary, live, inFlight, liveLabel, toolForest),
    [block.steps, inFlight, live, liveLabel, summary, toolForest],
  );
  const streamingThought = inFlight ? getStreamingThought(block.steps) : undefined;
  const showThoughtWindow = !expanded && streamingThought !== undefined;
  const meta: string[] = [];
  if (summary.toolCount > 1 || (active && summary.toolCount > 0)) {
    meta.push(`${summary.toolCount} step${summary.toolCount === 1 ? "" : "s"}`);
  }
  if (active && summary.durationMs !== undefined && summary.durationMs >= 1000) {
    meta.push(formatDuration(summary.durationMs, { wholeSeconds: true }));
  }

  return (
    <div className="min-w-0" data-activity-block={block.key} data-activity-state={active ? "active" : "done"}>
      <button
        type="button"
        onClick={() => onToggle(block.key, !expanded)}
        aria-expanded={expanded}
        className={cx("group/activity", DS.row.inline, DS.row.interactive)}
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={cx(DS.row.chevron, "group-hover/activity:text-text-muted", expanded && DS.row.chevronOpen)}
        />
        {/* The label keeps its width; the detail takes whatever is left and truncates first. */}
        <span className={cx(DS.row.label, "font-medium", active ? DS.motion.live : "text-text-secondary")}>
          {header.label}
        </span>
        {header.detail && (
          <span className={cx(DS.row.detail, "text-text-muted", header.detailMono && "font-mono text-[12px]")}>
            {header.detail}
          </span>
        )}
        {meta.length > 0 && (
          <span className="shrink-0 whitespace-nowrap pl-1 text-xs tabular-nums text-text-faint">
            {meta.join(" · ")}
          </span>
        )}
        {summary.failedCount > 0 && (
          <span className="shrink-0 whitespace-nowrap text-xs text-error/80">
            {summary.failedCount} failed
          </span>
        )}
      </button>
      {showThoughtWindow && <ThoughtWindow content={streamingThought} />}
      {expanded && (
        <div className={cx(DS.rail, DS.motion.reveal, "pb-1")}>
          {block.steps.map((step) => {
            if (step.kind === "reasoning") return <ReasoningStep key={step.key} entry={step.entry} />;
            const roots = buildRenderableSegmentRoots(step.entries, toolForest);
            return roots.length > 0 ? <ToolCallNodeGroup key={step.key} nodes={roots} /> : null;
          })}
        </div>
      )}
    </div>
  );
});
