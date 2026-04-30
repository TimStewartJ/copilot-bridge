import { memo, useMemo } from "react";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import { computeToolCallTracks } from "../lib/tool-call-tracks";
import type { ToolCallTrackOptions } from "../lib/tool-call-tracks";
import ParallelTrackGroup, { type ParallelTrackRenderOptions } from "./ParallelTrackGroup";
import SubAgentGroup from "./SubAgentGroup";
import ToolCallBlock from "./ToolCallBlock";

export interface ToolCallTreeProps extends ToolCallTrackOptions {
  node: ToolCallTreeNode;
  defaultExpanded?: boolean;
  contextOnly?: boolean;
}

export interface ToolCallNodeGroupProps extends ToolCallTrackOptions {
  nodes: ToolCallTreeNode[];
  defaultExpanded?: boolean;
  contextOnly?: boolean;
  className?: string;
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export const ToolCallTree = memo(function ToolCallTree({
  node,
  defaultExpanded = false,
  contextOnly = false,
  nowMs,
  activeToolCallIds,
}: ToolCallTreeProps) {
  const renderChildNodes = (childNodes: ToolCallTreeNode[]) => (
    <ToolCallNodeGroup
      nodes={childNodes}
      defaultExpanded={true}
      contextOnly={contextOnly}
      nowMs={nowMs}
      activeToolCallIds={activeToolCallIds}
    />
  );
  const effectiveContextOnly = contextOnly || node.isContextOnly;

  return node.toolCall.isSubAgent
    ? (
        <SubAgentGroup
          agentTool={node.toolCall}
          childNodes={node.children}
          renderChildNodes={renderChildNodes}
          defaultExpanded={defaultExpanded}
          contextOnly={effectiveContextOnly}
        />
      )
    : (
        <ToolCallBlock
          toolCall={node.toolCall}
          childNodes={node.children}
          renderChildNodes={renderChildNodes}
          defaultExpanded={defaultExpanded}
          contextOnly={effectiveContextOnly}
        />
      );
});

export const ToolCallNodeGroup = memo(function ToolCallNodeGroup({
  nodes,
  defaultExpanded = false,
  contextOnly = false,
  className,
  nowMs,
  activeToolCallIds,
}: ToolCallNodeGroupProps) {
  const layout = useMemo(
    () => computeToolCallTracks(nodes, { nowMs, activeToolCallIds }),
    [activeToolCallIds, nodes, nowMs],
  );
  const renderNode = (
    node: ToolCallTreeNode,
    options: ParallelTrackRenderOptions = {},
  ) => (
    <ToolCallTree
      key={node.toolCall.toolCallId}
      node={node}
      defaultExpanded={options.defaultExpanded ?? defaultExpanded}
      contextOnly={options.contextOnly ?? contextOnly}
      nowMs={nowMs}
      activeToolCallIds={activeToolCallIds}
    />
  );

  if (nodes.length === 0) return null;

  if (!layout.hasOverlap) {
    return (
      <div className={classNames("space-y-1", className)}>
        {nodes.map((node) => renderNode(node))}
      </div>
    );
  }

  return (
    <ParallelTrackGroup
      layout={layout}
      renderNode={renderNode}
      defaultExpanded={defaultExpanded}
      contextOnly={contextOnly}
      className={className}
    />
  );
});

export default ToolCallNodeGroup;
