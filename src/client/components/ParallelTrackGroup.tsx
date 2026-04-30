import { Fragment, memo, type ReactNode } from "react";
import type { ToolCallTreeNode } from "../lib/tool-call-tree";
import type { ToolCallTrackLane, ToolCallTrackLayout } from "../lib/tool-call-tracks";

export interface ParallelTrackRenderOptions {
  defaultExpanded?: boolean;
  contextOnly?: boolean;
}

export interface ParallelTrackGroupProps {
  layout: ToolCallTrackLayout;
  renderNode: (node: ToolCallTreeNode, options: ParallelTrackRenderOptions) => ReactNode;
  defaultExpanded?: boolean;
  contextOnly?: boolean;
  className?: string;
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function formatToolCount(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

export default memo(function ParallelTrackGroup({
  layout,
  renderNode,
  defaultExpanded = false,
  contextOnly = false,
  className,
}: ParallelTrackGroupProps) {
  return (
    <div className={classNames("rounded-md border border-border/60 bg-bg-secondary/25 p-2", className)}>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:overflow-x-auto md:pb-1">
        {layout.lanes.map((lane) => {
          const label = `Track ${lane.index + 1}`;
          const countLabel = formatToolCount(lane.items.length);
          return (
            <div
              key={lane.index}
              role="group"
              aria-label={`${label}, ${countLabel}`}
              className="min-w-0 rounded-md border border-border/70 border-l-2 border-l-accent/30 bg-bg-primary/70 p-1.5 md:w-80 md:shrink-0"
            >
              <div className="mb-1 flex items-center px-0.5">
                <span className="rounded-full border border-border/60 bg-bg-surface/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-text-secondary">
                  {label}
                </span>
              </div>
              <div className="space-y-1">
                {lane.items.map((item) => (
                  <Fragment key={item.node.toolCall.toolCallId}>
                    {renderNode(item.node, { defaultExpanded, contextOnly })}
                  </Fragment>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
