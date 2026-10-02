import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolArgs, ToolCall } from "../../api";
import {
  collectActivityCalls,
  getReasoningHeadline,
  getReasoningTail,
  getStepStatus,
  launchesBackgroundAgent,
  summarizeActivity,
  type ActivityBlock as ActivityBlockModel,
  type ActivityStep,
  type ActivitySummary,
} from "../../lib/chat-activity";
import { buildRenderableSegmentRoots, type ToolCallForest } from "../../lib/tool-call-tree";
import {
  describeToolCall,
  describeToolCallBriefly,
  formatDuration,
  type ToolPresentationContext,
} from "../../lib/tool-presentation";
import { agentDisplayName, describeWaitingOnAgents, listAgentNames } from "../../lib/transcript-agents";
import { useNow } from "../../hooks/useNow";
import ToolCallNodeGroup from "../ToolCallNodeGroup";
import ReasoningStep from "./ReasoningStep";
import { useChatRunActive } from "./chat-run-context";
import { ActivityBlockKeyProvider, useAgentNameResolver } from "./transcript-agents-context";
import { DS, cx } from "../../design/tokens";

/** What to say on the line of a run whose main agent has stopped to wait for agents. */
export interface ActivityWaitingText {
  label: string;
  detail?: string;
  /** How many agents are being waited on. Others may have finished earlier in the same stretch. */
  count?: number;
}

interface ActivityBlockProps {
  block: ActivityBlockModel;
  toolForest: ToolCallForest;
  expanded: boolean;
  onToggle: (key: string, expanded: boolean) => void;
  /** The run is still going and this block is where its next step will land. */
  live?: boolean;
  /**
   * This block is the last thing in the transcript, so a step still in flight in it is what the
   * run is doing now. An agent can leave a step in flight in an earlier block; that block keeps
   * its summary, and the agent's row inside it shows the step. A block shown on its own is the last.
   */
  latest?: boolean;
  /** What the agent says it is doing, shown while no single step is in flight. */
  liveLabel?: string;
  /** The main agent is waiting on agents. Shown in place of whichever agent's step came last. */
  waiting?: ActivityWaitingText;
}

interface HeaderText {
  label: string;
  detail?: string;
  detailMono?: boolean;
  /**
   * The line is about agents and the main agent did nothing else in this stretch, so the figures
   * beside it are the agents' steps and need not say whose they are.
   */
  agentsOnly?: boolean;
  /**
   * How many agents the line speaks of, when more may have worked in the stretch: the ones still
   * being waited on, not the ones that have finished. The figures then say how many they cover.
   */
  agentsNamed?: number;
}

/** Shown only where the line has room for it: beside a side panel or on a phone it is dropped. */
const ROOMY_ONLY = "hidden @[30rem]/activity:inline";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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

function getStreamingThought(steps: ActivityStep[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === "reasoning" && step.entry.reasoning.streaming) return step.entry.content;
  }
  return undefined;
}

function getDescriptionArg(args: ToolArgs | undefined): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = args.description;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workedLabel(subject: string | undefined, durationMs: number | undefined): string {
  const verb = subject ? `${subject} worked` : "Worked";
  return durationMs !== undefined && durationMs >= 1000 ? `${verb} for ${formatDuration(durationMs)}` : verb;
}

/**
 * The main agent's step in flight, for the collapsed line. Steps agents take in the background are
 * left to their own rows: several agents take turns many times a minute, and a line that followed
 * them would say something different every time it was read.
 */
function describeStepInFlight(
  main: ToolCall[],
  inAgents: ToolCall[],
  context: ToolPresentationContext,
): HeaderText | undefined {
  const running = main.filter((toolCall) => getStepStatus(toolCall) === "running");
  if (running.length === 0) return undefined;

  const ownSteps = running.filter((toolCall) => !toolCall.isSubAgent);
  if (ownSteps.length > 0) {
    const current = ownSteps[ownSteps.length - 1]!;
    const presentation = describeToolCall(current, "running", context);
    const others = running.length - 1;
    const more = others > 0 ? `+${others} more` : undefined;
    return {
      label: presentation.verb,
      detail: [presentation.target, more].filter(Boolean).join("  ·  ") || undefined,
      detailMono: presentation.mono && !more,
    };
  }

  // Everything in flight is an agent the main agent handed work to and is waiting for.
  const agentsOnly = main.every((toolCall) => toolCall.isSubAgent);
  if (running.length > 1) {
    const waitingOn = describeWaitingOnAgents(running.map((toolCall) => ({
      name: agentDisplayName(toolCall),
      description: toolCall.agent?.description ?? getDescriptionArg(toolCall.args),
    })));
    return { label: waitingOn.label, detail: waitingOn.detail, agentsOnly, agentsNamed: waitingOn.count };
  }
  // One agent can run for minutes, so the line names it and what it is doing right now.
  const agent = running[0]!;
  const step = [...inAgents].reverse().find((toolCall) => (
    toolCall.parentToolCallId === agent.toolCallId && getStepStatus(toolCall) === "running"
  ));
  const stepPresentation = step ? describeToolCall(step, "running", context) : undefined;
  return {
    label: agentDisplayName(agent),
    detail: stepPresentation
      ? describeToolCallBriefly(stepPresentation)
      : describeToolCall(agent, "running", context).target,
    agentsOnly,
    agentsNamed: 1,
  };
}

function describeHeader(input: {
  steps: ActivityStep[];
  summary: ActivitySummary;
  active: boolean;
  inFlight: boolean;
  liveLabel: string | undefined;
  waiting: ActivityWaitingText | undefined;
  toolForest: ToolCallForest;
  context: ToolPresentationContext;
}): HeaderText {
  const { steps, summary, active, inFlight, liveLabel, waiting, toolForest, context } = input;
  const { main, inAgents } = collectActivityCalls(steps);

  if (active) {
    // The runtime says the main agent has stopped, so nothing of its own is in flight.
    if (waiting) {
      return {
        label: waiting.label,
        detail: waiting.detail,
        agentsOnly: main.every((toolCall) => toolCall.isSubAgent),
        agentsNamed: waiting.count,
      };
    }
    if (inFlight && summary.streamingThought) return { label: "Thinking" };
    const step = inFlight ? describeStepInFlight(main, inAgents, context) : undefined;
    return step ?? { label: liveLabel?.trim() || "Working" };
  }

  if (main.length === 0 && inAgents.length === 0) {
    const first = steps.find((step) => step.kind === "reasoning");
    return {
      label: "Thought",
      detail: first?.kind === "reasoning" ? getReasoningHeadline(first.entry.content) || undefined : undefined,
    };
  }

  // Agents launched in an earlier stretch that kept working through this one.
  const continued = steps.flatMap((step) => step.kind === "agent" ? [step.agentToolCallId] : []);

  if (main.length === 0) {
    // Nothing here is the main agent's.
    const only = continued.length === 1 ? toolForest.nodesById.get(continued[0]!)?.toolCall : undefined;
    const subject = only ? agentDisplayName(only) : continued.length > 1 ? plural(continued.length, "agent") : undefined;
    return { label: workedLabel(subject, summary.durationMs), agentsOnly: subject !== undefined };
  }

  const handedOut = continued.length === 0
    && main.every((toolCall) => toolCall.isSubAgent && getStepStatus(toolCall) !== "failed");

  if (handedOut && summary.agentToolCount === 0 && main.every(launchesBackgroundAgent)) {
    // All that happened here is that work was handed out. What came of it is on the agents' rows,
    // in the stretches where they did it.
    const [only] = main;
    return main.length === 1
      ? {
          label: `Launched ${agentDisplayName(only!)}`,
          detail: describeToolCall(only!, "done", context).target,
          agentsOnly: true,
        }
      : {
          label: `Launched ${plural(main.length, "agent")}`,
          detail: listAgentNames(main.map((toolCall) => ({ name: agentDisplayName(toolCall) })), 4),
          agentsOnly: true,
        };
  }

  if (main.length === 1 && continued.length === 0) {
    // One call says it all: the call itself, or a delegation and what its agent did.
    const only = main[0]!;
    const status = getStepStatus(only);
    // A lone call that never recorded a completion, in a run that is over, reads in the past tense.
    const presentation = describeToolCall(only, status === "running" ? "done" : status, context);
    return {
      label: presentation.verb,
      detail: presentation.target,
      detailMono: presentation.mono,
      agentsOnly: only.isSubAgent === true,
    };
  }

  // Every call here handed work to an agent, so the stretch is the agents' and reads as theirs.
  if (handedOut) return { label: workedLabel(plural(main.length, "agent"), summary.durationMs), agentsOnly: true };

  return { label: workedLabel(undefined, summary.durationMs) };
}

/**
 * Everything that happened between two things the agent said, as one line that opens into a
 * timeline: its thinking, its tool calls, and one row for each agent that was at work. While the
 * run is live the line names the main agent's step in flight, or says it is waiting on agents.
 */
export default memo(function ActivityBlock({
  block,
  toolForest,
  expanded,
  onToggle,
  live = false,
  latest = true,
  liveLabel,
  waiting,
}: ActivityBlockProps) {
  const runActive = useChatRunActive();
  const agentName = useAgentNameResolver();
  const context = useMemo<ToolPresentationContext>(() => ({ agentName }), [agentName]);
  // Steps with no recorded end are in flight only while the run that owns them is still going.
  const inFlight = useMemo(() => {
    if (!runActive) return false;
    const snapshot = summarizeActivity(block.steps);
    return snapshot.runningCount > 0 || snapshot.streamingThought;
  }, [block.steps, runActive]);
  const active = live || (inFlight && latest);
  const now = useNow(active);
  const summary = useMemo(
    () => summarizeActivity(block.steps, active ? now : undefined),
    [active, block.steps, now],
  );
  const header = useMemo(
    () => describeHeader({
      steps: block.steps,
      summary,
      active,
      inFlight,
      liveLabel,
      waiting: active ? waiting : undefined,
      toolForest,
      context,
    }),
    [active, block.steps, context, inFlight, liveLabel, summary, toolForest, waiting],
  );
  const streamingThought = active && inFlight ? getStreamingThought(block.steps) : undefined;
  const showThoughtWindow = !expanded && streamingThought !== undefined;

  // The figures: the main agent's steps, then how many agents worked and how much they did. A line
  // that is about those agents alone gives just their steps.
  const agentSteps = summary.agentToolCount > 0 ? plural(summary.agentToolCount, "step") : undefined;
  const stepsAreTheNamedAgents = header.agentsOnly === true
    && (header.agentsNamed === undefined || summary.agentCount <= header.agentsNamed);
  const agentsAtWork = !stepsAreTheNamedAgents && agentSteps && summary.agentCount > 0
    ? plural(summary.agentCount, "agent")
    : undefined;
  // One step of its own goes without saying, unless it has to be told apart from the agents'.
  const ownSteps = !header.agentsOnly
    && (summary.toolCount > 1 || (summary.toolCount > 0 && (active || agentsAtWork !== undefined)))
    ? plural(summary.toolCount, "step")
    : undefined;
  const hasCounts = stepsAreTheNamedAgents ? Boolean(agentSteps) : Boolean(ownSteps || agentsAtWork);
  const elapsed = active && summary.durationMs !== undefined && summary.durationMs >= 1000
    ? formatDuration(summary.durationMs, { wholeSeconds: true })
    : undefined;
  const failedTotal = summary.failedCount + (header.agentsOnly ? summary.agentFailedCount : 0);

  return (
    <div
      className="min-w-0"
      data-activity-block={block.key}
      data-activity-state={active ? "active" : "done"}
      data-activity-waiting={active && waiting ? "agents" : undefined}
    >
      {/* Only the line is measured: a container around the rows would trap the dialogs they open. */}
      <div className="@container/activity min-w-0">
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
          {(hasCounts || elapsed) && (
            <span className="shrink-0 whitespace-nowrap pl-1 text-xs tabular-nums text-text-faint" data-activity-meta="">
              {stepsAreTheNamedAgents ? agentSteps : (
                <>
                  {ownSteps}
                  {agentsAtWork && (
                    <>
                      {ownSteps && " · "}
                      {agentsAtWork}
                      <span className={ROOMY_ONLY}>, {agentSteps}</span>
                    </>
                  )}
                </>
              )}
              {elapsed && (
                <>
                  {hasCounts && " · "}
                  {elapsed}
                </>
              )}
            </span>
          )}
          {failedTotal > 0 && (
            <span className="shrink-0 whitespace-nowrap text-xs text-error/80">
              {failedTotal} failed
            </span>
          )}
          {!header.agentsOnly && summary.agentFailedCount > 0 && (
            <span className={cx("shrink-0 whitespace-nowrap text-xs text-error/80", ROOMY_ONLY)}>
              {summary.agentFailedCount} failed in agents
            </span>
          )}
        </button>
      </div>
      {showThoughtWindow && <ThoughtWindow content={streamingThought} />}
      {expanded && (
        <div className={cx(DS.rail, DS.motion.reveal, "pb-1")}>
          <ActivityBlockKeyProvider value={block.key}>
            {block.steps.map((step) => {
              if (step.kind === "reasoning") return <ReasoningStep key={step.key} entry={step.entry} />;
              // An agent's step renders under the call that launched it, wherever that call is.
              const roots = buildRenderableSegmentRoots(step.entries, toolForest);
              return roots.length > 0 ? <ToolCallNodeGroup key={step.key} nodes={roots} /> : null;
            })}
          </ActivityBlockKeyProvider>
        </div>
      )}
    </div>
  );
});
