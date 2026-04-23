import { memo } from "react";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import SubAgentGroup from "./SubAgentGroup";
import ToolCallBlock from "./ToolCallBlock";

interface ToolCallTreeProps {
  node: ToolCallTreeNode;
  defaultExpanded?: boolean;
}

export default memo(function ToolCallTree({ node, defaultExpanded = false }: ToolCallTreeProps) {
  const renderChildNode = (childNode: ToolCallTreeNode) => (
    <ToolCallTree
      key={childNode.toolCall.toolCallId}
      node={childNode}
      defaultExpanded={childNode.children.length > 0}
    />
  );

  return node.toolCall.isSubAgent
    ? <SubAgentGroup agentTool={node.toolCall} childNodes={node.children} renderChildNode={renderChildNode} defaultExpanded={defaultExpanded} contextOnly={node.isContextOnly} />
    : <ToolCallBlock toolCall={node.toolCall} childNodes={node.children} renderChildNode={renderChildNode} defaultExpanded={defaultExpanded} contextOnly={node.isContextOnly} />;
});
