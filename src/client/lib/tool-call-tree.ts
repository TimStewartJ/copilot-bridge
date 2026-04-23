import type { ChatEntry, ChatMessage, ChatToolEntry, ToolCall } from "../api";
import { getToolCallStatus, type ToolCallStatus } from "./tool-call-status";

export interface ToolCallTreeNode {
  toolCall: ToolCall;
  children: ToolCallTreeNode[];
  depth: number;
  rootToolCallId: string;
  status: ToolCallStatus;
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
  | { type: "tool-segment"; entries: ChatToolEntry[] };

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

function buildPrunedNode(
  node: ToolCallTreeNode,
  includeIds: Set<string>,
  depth: number,
  rootToolCallId: string,
): ToolCallTreeNode {
  const children = node.children
    .filter((child) => includeIds.has(child.toolCall.toolCallId))
    .map((child) => buildPrunedNode(child, includeIds, depth + 1, rootToolCallId));
  const status = getToolCallStatus(node.toolCall);
  let runningCount = status === "running" ? 1 : 0;
  let doneCount = status === "done" ? 1 : 0;
  let failedCount = status === "failed" ? 1 : 0;

  for (const child of children) {
    runningCount += child.runningCount;
    doneCount += child.doneCount;
    failedCount += child.failedCount;
  }

  return {
    toolCall: node.toolCall,
    children,
    depth,
    rootToolCallId,
    status,
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
  const orderedRootIds: string[] = [];
  const seenRootIds = new Set<string>();

  for (const entry of segmentEntries) {
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
    return root ? [buildPrunedNode(root, includeIds, 0, rootId)] : [];
  });
}

export function segmentChatEntries(entries: ChatEntry[]): ChatRenderSegment[] {
  const segments: ChatRenderSegment[] = [];
  let currentToolEntries: ChatToolEntry[] = [];

  const flushToolSegment = () => {
    if (currentToolEntries.length === 0) return;
    segments.push({ type: "tool-segment", entries: currentToolEntries });
    currentToolEntries = [];
  };

  for (const entry of entries) {
    if (entry.type === "tool" && entry.toolCall) {
      currentToolEntries.push(entry);
      continue;
    }

    flushToolSegment();
    segments.push({ type: "message", entry: entry as ChatMessage });
  }

  flushToolSegment();
  return segments;
}

export function formatToolCallCounts(node: ToolCallTreeNode): string | null {
  const parts: string[] = [];
  if (node.runningCount > 0) parts.push(`${node.runningCount} running`);
  if (node.doneCount > 0) parts.push(`${node.doneCount} done`);
  if (node.failedCount > 0) parts.push(`${node.failedCount} failed`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
