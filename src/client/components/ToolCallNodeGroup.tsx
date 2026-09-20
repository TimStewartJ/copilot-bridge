import { memo } from "react";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import SubAgentGroup from "./SubAgentGroup";
import ToolCallBlock from "./ToolCallBlock";

export interface ToolCallTreeProps {
  node: ToolCallTreeNode;
  defaultExpanded?: boolean;
  contextOnly?: boolean;
}

export interface ToolCallNodeGroupProps {
  nodes: ToolCallTreeNode[];
  defaultExpanded?: boolean;
  contextOnly?: boolean;
  className?: string;
}

export const ToolCallTree = memo(function ToolCallTree({
  node,
  defaultExpanded = false,
  contextOnly = false,
}: ToolCallTreeProps) {
  const renderChildNodes = (childNodes: ToolCallTreeNode[]) => (
    <ToolCallNodeGroup nodes={childNodes} defaultExpanded={true} contextOnly={contextOnly} />
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

/**
 * Sibling tool calls, one row each in the order they started. Calls that ran in parallel are
 * simply adjacent rows: their spinners and durations already say they overlapped.
 */
export const ToolCallNodeGroup = memo(function ToolCallNodeGroup({
  nodes,
  defaultExpanded = false,
  contextOnly = false,
  className,
}: ToolCallNodeGroupProps) {
  if (nodes.length === 0) return null;
  return (
    <div className={className}>
      {nodes.map((node) => (
        <ToolCallTree
          key={node.toolCall.toolCallId}
          node={node}
          defaultExpanded={defaultExpanded}
          contextOnly={contextOnly}
        />
      ))}
    </div>
  );
});

export default ToolCallNodeGroup;
