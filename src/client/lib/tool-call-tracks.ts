import type { ToolCallTreeNode } from "./tool-call-tree";

export interface ToolCallTrackOptions {
  nowMs?: number;
  activeToolCallIds?: Iterable<string>;
}

export interface ToolCallTrackItem {
  node: ToolCallTreeNode;
  inputIndex: number;
  laneIndex: number;
  startMs: number;
  endMs: number;
  renderEndMs: number;
}

export interface ToolCallTrackLane {
  index: number;
  items: ToolCallTrackItem[];
}

export interface ToolCallTrackLayout {
  lanes: ToolCallTrackLane[];
  trackCount: number;
  maxConcurrency: number;
  hasOverlap: boolean;
}

interface ComputationOptions {
  nowMs?: number;
  activeToolCallIds?: ReadonlySet<string>;
}

interface NormalizedInterval {
  node: ToolCallTreeNode;
  inputIndex: number;
  startMs: number;
  endMs: number;
  renderEndMs: number;
  hasVisibleToolCall: boolean;
}

interface MutableTrackLane {
  index: number;
  endMs: number;
  items: ToolCallTrackItem[];
}

export function computeToolCallTracks(
  nodes: ToolCallTreeNode[],
  options: ToolCallTrackOptions = {},
): ToolCallTrackLayout {
  const computationOptions = normalizeOptions(options);
  const intervals = normalizeSiblingIntervals(nodes, computationOptions);
  const orderedIntervals = [...intervals].sort(compareIntervals);
  const mutableLanes: MutableTrackLane[] = [];

  for (const interval of orderedIntervals) {
    let lane = mutableLanes.find((candidate) => candidate.endMs <= interval.startMs);
    if (!lane) {
      lane = { index: mutableLanes.length, endMs: interval.endMs, items: [] };
      mutableLanes.push(lane);
    }

    const item: ToolCallTrackItem = {
      node: interval.node,
      inputIndex: interval.inputIndex,
      laneIndex: lane.index,
      startMs: interval.startMs,
      endMs: interval.endMs,
      renderEndMs: interval.renderEndMs,
    };
    lane.items.push(item);
    lane.endMs = interval.endMs;
  }

  const maxConcurrency = computeMaxConcurrency(intervals);

  return {
    lanes: mutableLanes.map(({ index, items }) => ({ index, items })),
    trackCount: mutableLanes.length,
    maxConcurrency,
    hasOverlap: maxConcurrency > 1,
  };
}

function normalizeOptions(options: ToolCallTrackOptions): ComputationOptions {
  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
    ? options.nowMs
    : undefined;
  return {
    nowMs,
    activeToolCallIds: options.activeToolCallIds
      ? new Set(options.activeToolCallIds)
      : undefined,
  };
}

function normalizeSiblingIntervals(
  nodes: ToolCallTreeNode[],
  options: ComputationOptions,
): NormalizedInterval[] {
  const earliestValidStartMs = nodes.reduce<number | undefined>((earliest, node) => {
    const startMs = parseTimestampMs(node.toolCall.startedAt);
    if (startMs === undefined) return earliest;
    return earliest === undefined ? startMs : Math.min(earliest, startMs);
  }, undefined);

  let previousStartMs: number | undefined;
  return nodes.map((node, inputIndex) => {
    const ownStartMs = parseTimestampMs(node.toolCall.startedAt);
    const fallbackStartMs = previousStartMs ?? earliestValidStartMs ?? 0;
    const startMs = ownStartMs ?? fallbackStartMs;
    const interval = normalizeNodeInterval(node, inputIndex, startMs, options);
    previousStartMs = interval.startMs;
    return interval;
  });
}

function normalizeNodeInterval(
  node: ToolCallTreeNode,
  inputIndex: number,
  fallbackStartMs: number,
  options: ComputationOptions,
): NormalizedInterval {
  if (node.isContextOnly) {
    return normalizeContextOnlyInterval(node, inputIndex, fallbackStartMs, options);
  }

  const completedMs = parseTimestampMs(node.toolCall.completedAt);
  const endMs = completedMs !== undefined && completedMs >= fallbackStartMs
    ? completedMs
    : getMissingCompletionEndMs(node, fallbackStartMs, options);

  return {
    node,
    inputIndex,
    startMs: fallbackStartMs,
    endMs,
    renderEndMs: resolveRenderEndMs(fallbackStartMs, endMs, options),
    hasVisibleToolCall: true,
  };
}

function normalizeContextOnlyInterval(
  node: ToolCallTreeNode,
  inputIndex: number,
  fallbackStartMs: number,
  options: ComputationOptions,
): NormalizedInterval {
  const descendantIntervals = normalizeSiblingIntervals(node.children, options)
    .filter((interval) => interval.hasVisibleToolCall);

  if (descendantIntervals.length === 0) {
    return {
      node,
      inputIndex,
      startMs: fallbackStartMs,
      endMs: fallbackStartMs,
      renderEndMs: fallbackStartMs,
      hasVisibleToolCall: false,
    };
  }

  const startMs = Math.min(...descendantIntervals.map((interval) => interval.startMs));
  const endMs = descendantIntervals.some((interval) => !Number.isFinite(interval.endMs))
    ? Number.POSITIVE_INFINITY
    : Math.max(...descendantIntervals.map((interval) => interval.endMs));

  return {
    node,
    inputIndex,
    startMs,
    endMs,
    renderEndMs: resolveRenderEndMs(startMs, endMs, options),
    hasVisibleToolCall: true,
  };
}

function getMissingCompletionEndMs(
  node: ToolCallTreeNode,
  startMs: number,
  options: ComputationOptions,
): number {
  const isActive = options.activeToolCallIds
    ? options.activeToolCallIds.has(node.toolCall.toolCallId)
    : node.status === "running";
  return isActive ? Number.POSITIVE_INFINITY : startMs;
}

function resolveRenderEndMs(
  startMs: number,
  endMs: number,
  options: ComputationOptions,
): number {
  if (Number.isFinite(endMs)) return endMs;
  return Math.max(startMs, options.nowMs ?? startMs);
}

function computeMaxConcurrency(intervals: NormalizedInterval[]): number {
  const countableIntervals = intervals.filter((interval) => interval.hasVisibleToolCall);
  if (countableIntervals.length === 0) return 0;

  const events = countableIntervals.flatMap((interval) => {
    if (interval.endMs <= interval.startMs) return [];
    return [
      { time: interval.startMs, delta: 1, typeOrder: 1, inputIndex: interval.inputIndex },
      { time: interval.endMs, delta: -1, typeOrder: 0, inputIndex: interval.inputIndex },
    ];
  }).sort((left, right) => (
    compareNumbers(left.time, right.time)
    || left.typeOrder - right.typeOrder
    || left.inputIndex - right.inputIndex
  ));

  let current = 0;
  let max = 0;
  for (const event of events) {
    current += event.delta;
    max = Math.max(max, current);
  }

  return Math.max(1, max);
}

function compareIntervals(left: NormalizedInterval, right: NormalizedInterval): number {
  return compareNumbers(left.startMs, right.startMs) || left.inputIndex - right.inputIndex;
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
