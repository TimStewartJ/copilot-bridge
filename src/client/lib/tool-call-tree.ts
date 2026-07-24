import type { ChatCompletionEntry, ChatEntry, ChatMessage, ChatSkillEntry, ChatToolEntry, ChatVisualEntry, ToolCall } from "../api";
import { getToolCallStatus, type ToolCallStatus } from "./tool-call-status";

export interface ToolCallTreeNode {
  toolCall: ToolCall;
  children: ToolCallTreeNode[];
  depth: number;
  rootToolCallId: string;
  status: ToolCallStatus;
  isContextOnly: boolean;
  descendantCount: number;
  runningCount: number;
  doneCount: number;
  failedCount: number;
}

interface MutableToolCallNode {
  toolCall: ToolCall;
  order: number;
  children: MutableToolCallNode[];
}

export interface ToolCallForest {
  roots: ToolCallTreeNode[];
  nodesById: Map<string, ToolCallTreeNode>;
}

export type ChatRenderSegment =
  | { type: "message"; entry: ChatMessage }
  | {
      type: "tool-segment";
      entries: ChatToolEntry[];
      turnId?: string;
      turnInstanceId?: string;
    }
  | { type: "visual-segment"; entry: ChatVisualEntry }
  | { type: "skill-segment"; entry: ChatSkillEntry }
  | { type: "completion-segment"; entry: ChatCompletionEntry };

export function buildToolCallForest(toolCalls: ToolCall[]): ToolCallForest {
  const mutableNodes = new Map<string, MutableToolCallNode>();

  toolCalls.forEach((toolCall, order) => {
    const existing = mutableNodes.get(toolCall.toolCallId);
    if (existing) {
      existing.toolCall = toolCall;
      return;
    }
    mutableNodes.set(toolCall.toolCallId, { toolCall, order, children: [] });
  });

  const attachedChildIds = new Set<string>();
  for (const node of mutableNodes.values()) {
    const parentId = node.toolCall.parentToolCallId;
    if (!parentId) continue;
    const parent = mutableNodes.get(parentId);
    if (!parent) continue;
    parent.children.push(node);
    attachedChildIds.add(node.toolCall.toolCallId);
  }

  const sortByOrder = (a: MutableToolCallNode, b: MutableToolCallNode) => a.order - b.order;
  const rootMutableNodes = [...mutableNodes.values()]
    .filter((node) => !attachedChildIds.has(node.toolCall.toolCallId))
    .sort(sortByOrder);

  for (const node of mutableNodes.values()) {
    node.children.sort(sortByOrder);
  }

  const nodesById = new Map<string, ToolCallTreeNode>();

  const finalizeNode = (
    mutableNode: MutableToolCallNode,
    depth: number,
    rootToolCallId: string,
  ): ToolCallTreeNode => {
    const children = mutableNode.children.map((child) =>
      finalizeNode(child, depth + 1, rootToolCallId),
    );
    const status = getToolCallStatus(mutableNode.toolCall);
    let runningCount = status === "running" ? 1 : 0;
    let doneCount = status === "done" ? 1 : 0;
    let failedCount = status === "failed" ? 1 : 0;

    for (const child of children) {
      runningCount += child.runningCount;
      doneCount += child.doneCount;
      failedCount += child.failedCount;
    }

    const node: ToolCallTreeNode = {
      toolCall: mutableNode.toolCall,
      children,
      depth,
      rootToolCallId,
      status,
      isContextOnly: false,
      descendantCount: children.reduce((sum, child) => sum + 1 + child.descendantCount, 0),
      runningCount,
      doneCount,
      failedCount,
    };
    nodesById.set(node.toolCall.toolCallId, node);
    return node;
  };

  const roots = rootMutableNodes.map((node) => finalizeNode(node, 0, node.toolCall.toolCallId));
  return { roots, nodesById };
}

export function getActiveToolCallRoots(roots: ToolCallTreeNode[]): ToolCallTreeNode[] {
  return roots.filter((root) => root.runningCount > 0);
}

function buildContextToolCall(toolCall: ToolCall, isVisible: boolean): ToolCall {
  if (isVisible) return toolCall;
  return {
    toolCallId: toolCall.toolCallId,
    name: toolCall.name,
    parentToolCallId: toolCall.parentToolCallId,
    isSubAgent: toolCall.isSubAgent,
  };
}

function buildPrunedNode(
  node: ToolCallTreeNode,
  includeIds: Set<string>,
  visibleToolCalls: Map<string, ToolCall>,
  visibleOrderById: Map<string, number>,
  firstVisibleOrderById: Map<string, number>,
  depth: number,
  rootToolCallId: string,
): ToolCallTreeNode {
  const children = node.children
    .filter((child) => includeIds.has(child.toolCall.toolCallId))
    .map((child) => buildPrunedNode(
      child,
      includeIds,
      visibleToolCalls,
      visibleOrderById,
      firstVisibleOrderById,
      depth + 1,
      rootToolCallId,
    ))
    .sort((left, right) => (
      (firstVisibleOrderById.get(left.toolCall.toolCallId) ?? Number.POSITIVE_INFINITY)
      - (firstVisibleOrderById.get(right.toolCall.toolCallId) ?? Number.POSITIVE_INFINITY)
    ));
  const visibleToolCall = visibleToolCalls.get(node.toolCall.toolCallId);
  const isContextOnly = !visibleToolCall;
  const toolCall = visibleToolCall ?? buildContextToolCall(node.toolCall, false);
  const status = getToolCallStatus(toolCall);
  let runningCount = !isContextOnly && status === "running" ? 1 : 0;
  let doneCount = !isContextOnly && status === "done" ? 1 : 0;
  let failedCount = !isContextOnly && status === "failed" ? 1 : 0;
  const firstVisibleOrder = Math.min(
    visibleOrderById.get(node.toolCall.toolCallId) ?? Number.POSITIVE_INFINITY,
    ...children.map((child) => firstVisibleOrderById.get(child.toolCall.toolCallId) ?? Number.POSITIVE_INFINITY),
  );
  firstVisibleOrderById.set(node.toolCall.toolCallId, firstVisibleOrder);

  for (const child of children) {
    runningCount += child.runningCount;
    doneCount += child.doneCount;
    failedCount += child.failedCount;
  }

  return {
    toolCall,
    children,
    depth,
    rootToolCallId,
    status,
    isContextOnly,
    descendantCount: children.reduce((sum, child) => sum + 1 + child.descendantCount, 0),
    runningCount,
    doneCount,
    failedCount,
  };
}

export function buildRenderableSegmentRoots(
  segmentEntries: ChatToolEntry[],
  fullForest: ToolCallForest,
): ToolCallTreeNode[] {
  const includeIds = new Set<string>();
  const visibleToolCalls = new Map<string, ToolCall>();
  const visibleOrderById = new Map<string, number>();
  const firstVisibleOrderById = new Map<string, number>();
  const orderedRootIds: string[] = [];
  const seenRootIds = new Set<string>();

  for (const [index, entry] of segmentEntries.entries()) {
    visibleToolCalls.set(entry.toolCall.toolCallId, entry.toolCall);
    visibleOrderById.set(entry.toolCall.toolCallId, index);
    const node = fullForest.nodesById.get(entry.toolCall.toolCallId);
    if (!node) continue;

    if (!seenRootIds.has(node.rootToolCallId)) {
      seenRootIds.add(node.rootToolCallId);
      orderedRootIds.push(node.rootToolCallId);
    }

    let current: ToolCallTreeNode | undefined = node;
    while (current) {
      includeIds.add(current.toolCall.toolCallId);
      current = current.toolCall.parentToolCallId
        ? fullForest.nodesById.get(current.toolCall.parentToolCallId)
        : undefined;
    }
  }

  return orderedRootIds.flatMap((rootId) => {
    const root = fullForest.nodesById.get(rootId);
    return root ? [buildPrunedNode(root, includeIds, visibleToolCalls, visibleOrderById, firstVisibleOrderById, 0, rootId)] : [];
  });
}

export function segmentChatEntries(entries: ChatEntry[]): ChatRenderSegment[] {
  const segments: ChatRenderSegment[] = [];
  let interactionEntries: ChatEntry[] = [];

  const flushInteraction = () => {
    if (interactionEntries.length === 0) return;
    segments.push(...segmentInteractionEntries(interactionEntries));
    interactionEntries = [];
  };

  for (const entry of entries) {
    if ((!entry.type || entry.type === "message") && entry.role === "user") {
      flushInteraction();
      segments.push({ type: "message", entry });
      continue;
    }
    interactionEntries.push(entry);
  }

  flushInteraction();
  return segments;
}

function segmentInteractionEntries(entries: ChatEntry[]): ChatRenderSegment[] {
  const segments: ChatRenderSegment[] = [];
  const toolEntriesByTurnGroupId = new Map<string, ChatToolEntry[]>();
  const suppressedTurnGroupIds = new Set<string>();
  const renderedTurnGroupIds = new Set<string>();
  let currentToolEntries: ChatToolEntry[] = [];

  const flushToolSegment = () => {
    if (currentToolEntries.length === 0) return;
    segments.push({ type: "tool-segment", entries: currentToolEntries });
    currentToolEntries = [];
  };

  for (const entry of entries) {
    if (entry.type !== "tool" || !entry.toolCall) continue;
    const turnGroupId = getTurnGroupId(entry);
    if (!turnGroupId) continue;
    const turnEntries = toolEntriesByTurnGroupId.get(turnGroupId);
    if (turnEntries) {
      turnEntries.push(entry);
    } else {
      toolEntriesByTurnGroupId.set(turnGroupId, [entry]);
    }
  }

  mergeRootSubAgentTurnsWithDescendantTurns(
    toolEntriesByTurnGroupId,
    suppressedTurnGroupIds,
  );

  // TODO: Replace inferred turn/contiguous grouping with SDK-level run ids once they are available.
  for (const entry of entries) {
    if (entry.type === "tool" && entry.toolCall) {
      const turnGroupId = getTurnGroupId(entry);
      if (turnGroupId) {
        flushToolSegment();
        if (
          !suppressedTurnGroupIds.has(turnGroupId)
          && !renderedTurnGroupIds.has(turnGroupId)
        ) {
          renderedTurnGroupIds.add(turnGroupId);
          segments.push({
            type: "tool-segment",
            turnId: entry.turnId,
            turnInstanceId: entry.turnInstanceId,
            entries: toolEntriesByTurnGroupId.get(turnGroupId) ?? [entry],
          });
        }
        continue;
      }
      currentToolEntries.push(entry);
      continue;
    }

    flushToolSegment();

    if (entry.type === "visual" && entry.visual) {
      segments.push({ type: "visual-segment", entry: entry as ChatVisualEntry });
      continue;
    }

    if (entry.type === "skill" && (entry as ChatSkillEntry).skill) {
      segments.push({ type: "skill-segment", entry: entry as ChatSkillEntry });
      continue;
    }

    if (entry.type === "completion" && entry.completion) {
      segments.push({ type: "completion-segment", entry });
      continue;
    }

    segments.push({ type: "message", entry: entry as ChatMessage });
  }

  flushToolSegment();
  return segments;
}

function getTurnGroupId(entry: Pick<ChatEntry, "turnId" | "turnInstanceId">): string | undefined {
  if (entry.turnInstanceId) return `instance:${entry.turnInstanceId}`;
  return entry.turnId ? `provider:${entry.turnId}` : undefined;
}

function mergeRootSubAgentTurnsWithDescendantTurns(
  toolEntriesByTurnGroupId: Map<string, ChatToolEntry[]>,
  suppressedTurnGroupIds: Set<string>,
): void {
  const turnGroupIds = [...toolEntriesByTurnGroupId.keys()];
  const toolCallById = new Map<string, ToolCall>();
  for (const entries of toolEntriesByTurnGroupId.values()) {
    for (const entry of entries) {
      toolCallById.set(entry.toolCall.toolCallId, entry.toolCall);
    }
  }

  for (const [turnIndex, turnGroupId] of turnGroupIds.entries()) {
    if (suppressedTurnGroupIds.has(turnGroupId)) continue;
    const entries = toolEntriesByTurnGroupId.get(turnGroupId) ?? [];
    if (!isRootSubAgentOnlyTurn(entries)) continue;

    const rootIds = new Set(entries.map((entry) => entry.toolCall.toolCallId));
    const descendantTurnGroupIds = turnGroupIds.slice(turnIndex + 1).filter((candidateGroupId) => {
      if (suppressedTurnGroupIds.has(candidateGroupId)) return false;
      const candidateEntries = toolEntriesByTurnGroupId.get(candidateGroupId) ?? [];
      return candidateEntries.some((entry) =>
        entry.toolCall.parentToolCallId
        && rootIds.has(getRootToolCallId(entry.toolCall, toolCallById)));
    });
    if (descendantTurnGroupIds.length === 0) continue;

    const mergedEntries = [...entries];
    for (const descendantTurnGroupId of descendantTurnGroupIds) {
      mergedEntries.push(...(toolEntriesByTurnGroupId.get(descendantTurnGroupId) ?? []));
      suppressedTurnGroupIds.add(descendantTurnGroupId);
    }
    toolEntriesByTurnGroupId.set(turnGroupId, mergedEntries);
  }
}

function isRootSubAgentOnlyTurn(entries: ChatToolEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) =>
    entry.toolCall.isSubAgent && !entry.toolCall.parentToolCallId);
}

function getRootToolCallId(toolCall: ToolCall, toolCallById: ReadonlyMap<string, ToolCall>): string {
  const seenIds = new Set<string>();
  let current = toolCall;

  while (current.parentToolCallId && !seenIds.has(current.parentToolCallId)) {
    seenIds.add(current.parentToolCallId);
    const parent = toolCallById.get(current.parentToolCallId);
    if (!parent) return current.parentToolCallId;
    current = parent;
  }

  return current.toolCallId;
}

export function formatToolCallCounts(node: ToolCallTreeNode): string | null {
  const parts: string[] = [];
  if (node.runningCount > 0) parts.push(`${node.runningCount} running`);
  if (node.doneCount > 0) parts.push(`${node.doneCount} done`);
  if (node.failedCount > 0) parts.push(`${node.failedCount} failed`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
