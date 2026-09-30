import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronRight, ClipboardList, ExternalLink, GitPullRequest, Plus } from "lucide-react";
import type { EnrichedWorkItem, WorkMapData, WorkMapPullRequest, WorkMapTask } from "../api";
import { Button, IdentitySwatch, StatusIcon } from "../design/primitives";
import { IDENTITY_FILL, type IdentityColor } from "../design/identity";
import { DS, cx } from "../design/tokens";
import { PR_STATUS_STYLES, WI_TYPE_ICONS } from "../work-item-styles";
import {
  assignTaskColors,
  buildWorkItemLookup,
  buildWorkMapTree,
  countTaskPlacements,
  flattenWorkMapTree,
  isClosedState,
  layoutWorkMapLanes,
  treeNodeAttention,
  WORK_MAP_RELATION_LABELS,
  type WorkMapItemLookup,
  type WorkMapLaneCell,
  type WorkMapTreeNode,
  type WorkMapTreeRow,
  type WorkMapTreeSection,
} from "../work-map-tree";

const MAX_LANES = 6;
const LANE_WIDTH_PX = 14;
const ROW_STEP = 150;
const VISIBLE_LINKS = 2;

interface WorkMapTreeProps {
  data: WorkMapData;
  visibleWorkItemIds: ReadonlySet<string>;
  orphanPullRequests: Array<{ pullRequest: WorkMapPullRequest; tasks: WorkMapTask[] }>;
  creatingTaskForWorkItemId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Resolves true when the task was created. */
  onCreateTaskForWorkItems: (workItems: EnrichedWorkItem[]) => Promise<boolean>;
}

interface RowSelectGesture {
  /** Shift: select every row between the last clicked row and this one. */
  range: boolean;
  /** Ctrl/Cmd: add to or remove from the current selection instead of replacing it. */
  additive: boolean;
}

interface TreeContext {
  data: WorkMapData;
  lookup: WorkMapItemLookup;
  nodeById: Map<string, WorkMapTreeNode>;
  taskById: Map<string, WorkMapTask>;
  colors: Map<string, IdentityColor>;
  placements: Map<string, number>;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  highlightTaskId: string | null;
  creatingTaskForWorkItemId: string | null;
  /** The desktop row grid; the lane column is as wide as the section's lanes. */
  gridColumns: string;
  toggleCollapsed: (id: string) => void;
  toggleExpanded: (id: string) => void;
  selectRow: (id: string, gesture: RowSelectGesture) => void;
  setHighlightTaskId: (taskId: string | null) => void;
  onSelectTask: (taskId: string) => void;
  createTaskFor: (workItems: EnrichedWorkItem[]) => void;
}

function isSelectGesture(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}

function workItemUrl(context: TreeContext, id: string): string {
  const known = context.lookup.get(id);
  if (known) return known.url;
  return `https://${context.data.org}.visualstudio.com/${context.data.project}/_workitems/edit/${id}`;
}

function rowElementId(id: string): string {
  return `work-map-row-${id}`;
}

function stateStatus(state: string | null): "done" | "closed" | "open" {
  if (!isClosedState(state)) return "open";
  return state?.toLowerCase() === "removed" ? "closed" : "done";
}

function titleTone(node: WorkMapTreeNode): string {
  if (isClosedState(node.item.state)) return "text-text-faint";
  return node.mapItem ? "text-text-primary" : "text-text-secondary";
}

function pullRequestSummary(pullRequests: WorkMapPullRequest[]): ReactNode {
  if (pullRequests.length === 0) return null;
  const active = pullRequests.filter((pr) => pr.status === "active").length;
  return (
    <>
      {pullRequests.length} PR{pullRequests.length === 1 ? "" : "s"}
      {active > 0 && <span className="text-text-primary"> · {active} active</span>}
    </>
  );
}

function TypeIcon({ item }: { item: EnrichedWorkItem }) {
  const typeInfo = WI_TYPE_ICONS[item.type ?? ""];
  return (
    <span className={cx(DS.row.iconSlot, typeInfo?.color ?? "text-text-muted")} title={item.type ?? "Work item"}>
      {typeInfo?.icon ?? <ClipboardList size={12} />}
      <span className="sr-only">{item.type ?? "Work item"}</span>
    </span>
  );
}

function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} aria-hidden="true" className="ml-1.5 w-2.5 shrink-0 self-stretch border-l border-border-subtle" />
      ))}
    </>
  );
}

function CollapseToggle({ node, context }: { node: WorkMapTreeNode; context: TreeContext }) {
  const hasChildren = node.children.length > 0 || node.hiddenChildCount > 0;
  if (!hasChildren) return <span aria-hidden="true" className="w-4 shrink-0" />;
  const open = !context.collapsed.has(node.id);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} children of work item ${node.id}`}
      onClick={() => context.toggleCollapsed(node.id)}
      className={cx(DS.focus, "flex h-6 w-4 shrink-0 items-center justify-center rounded-sm text-text-faint hover:text-text-primary")}
    >
      <ChevronRight size={12} className={cx(DS.row.chevron, open && DS.row.chevronOpen)} />
    </button>
  );
}

function TaskLink({
  taskId,
  context,
  showPlacements,
}: {
  taskId: string;
  context: TreeContext;
  showPlacements: boolean;
}) {
  const task = context.taskById.get(taskId);
  if (!task) return null;
  const elsewhere = (context.placements.get(taskId) ?? 1) - 1;
  return (
    <button
      type="button"
      onClick={() => context.onSelectTask(taskId)}
      onMouseEnter={() => context.setHighlightTaskId(taskId)}
      onMouseLeave={() => context.setHighlightTaskId(null)}
      onFocus={() => context.setHighlightTaskId(taskId)}
      onBlur={() => context.setHighlightTaskId(null)}
      title={task.nextAction ? `${task.title}\nNext: ${task.nextAction}` : task.title}
      className={cx(DS.row.inline, DS.row.interactive, "max-w-full text-xs")}
    >
      <IdentitySwatch color={context.colors.get(taskId)} />
      <span className={cx("min-w-0 truncate", task.status === "archived" ? "text-text-secondary" : "text-text-primary")}>
        {task.title}
      </span>
      {showPlacements && elsewhere > 0 && (
        <span className="shrink-0 text-[11px] text-text-faint">+{elsewhere} more</span>
      )}
    </button>
  );
}

function CreateTaskButton({
  item,
  context,
  revealOnHover = false,
}: {
  item: EnrichedWorkItem;
  context: TreeContext;
  /** Rows that place other work, such as a feature above linked tasks, show it only on hover. */
  revealOnHover?: boolean;
}) {
  const creating = context.creatingTaskForWorkItemId === item.id;
  return (
    <button
      type="button"
      aria-label={`Create Bridge task for work item ${item.id}`}
      title={`Create a Bridge task linked to ${item.type ?? "work item"} ${item.id}`}
      disabled={context.creatingTaskForWorkItemId !== null}
      onClick={() => context.createTaskFor([item])}
      className={cx(
        DS.button.base,
        DS.button.size.sm,
        DS.button.variant.ghost,
        "gap-1",
        revealOnHover && !creating && "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100",
      )}
    >
      <Plus size={12} />
      {creating ? "Creating..." : "Task"}
    </button>
  );
}

function SelectBox({ node, context }: { node: WorkMapTreeNode; context: TreeContext }) {
  const checked = context.selected.has(node.id);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => undefined}
      onClick={(event) => {
        event.stopPropagation();
        context.selectRow(node.id, { range: event.shiftKey, additive: true });
      }}
      aria-label={`Select work item ${node.id}`}
      title="Select. Shift-click selects a range; Ctrl-click a row adds it."
      className={cx(
        DS.control.checkbox,
        "cursor-pointer",
        !checked && context.selected.size === 0 && "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100",
      )}
    />
  );
}

/**
 * What a row says about its neighbours: blocking and duplicate links by name, related links and
 * ADO children that are not on the map as counts. The expanded row lists them in full.
 */
function RowAnnotations({ node, context }: { node: WorkMapTreeNode; context: TreeContext }) {
  const named = node.links.filter((link) => link.type !== "related");
  const shown = named.slice(0, VISIBLE_LINKS);
  const related = node.links.filter((link) => link.type === "related");
  const unnamed = named.length - shown.length;
  const relatedTitle = related
    .map((link) => {
      const target = context.lookup.get(link.workItemId);
      return target?.title ? `#${link.workItemId} ${target.title}` : `#${link.workItemId}`;
    })
    .join("\n");
  return (
    <>
      {shown.map((link) => {
        const target = context.lookup.get(link.workItemId);
        const onTree = context.nodeById.has(link.workItemId);
        const label = WORK_MAP_RELATION_LABELS[link.type as keyof typeof WORK_MAP_RELATION_LABELS];
        const warning = link.type === "predecessor" && Boolean(target) && !isClosedState(target?.state);
        return (
          <a
            key={`${link.type}:${link.workItemId}`}
            href={onTree ? `#${rowElementId(link.workItemId)}` : workItemUrl(context, link.workItemId)}
            target={onTree ? undefined : "_blank"}
            rel={onTree ? undefined : "noopener"}
            onClick={(event) => {
              if (!onTree) return;
              event.preventDefault();
              document.getElementById(rowElementId(link.workItemId))?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
            title={target?.title ? `${label} #${link.workItemId}: ${target.title}${target.state ? ` (${target.state})` : ""}` : `${label} #${link.workItemId}`}
            className={cx(DS.focus, "shrink-0 rounded-sm text-[11px] hover:underline", warning ? DS.tone.warning : "text-text-secondary")}
          >
            {label} #{link.workItemId}
          </a>
        );
      })}
      {(unnamed > 0 || related.length > 0) && (
        <span className="shrink-0 text-[11px] text-text-faint" title={relatedTitle || undefined}>
          {[unnamed > 0 ? `+${unnamed} links` : null, related.length > 0 ? `${related.length} related` : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      {node.hiddenChildCount > 0 && (
        <a
          href={node.item.url}
          target="_blank"
          rel="noopener"
          title={`${node.hiddenChildCount} more child item${node.hiddenChildCount === 1 ? "" : "s"} in ADO ${node.hiddenChildCount === 1 ? "is" : "are"} not on the map`}
          className={cx(DS.focus, "shrink-0 rounded-sm text-[11px] text-text-faint hover:underline")}
        >
          +{node.hiddenChildCount} in ADO
        </a>
      )}
    </>
  );
}

function Attention({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <span className={cx("inline-flex max-w-full min-w-0 items-center gap-1 text-[11px]", DS.tone.warning)} title={items.join(". ")}>
      <StatusIcon kind="warning" size="sm" decorative />
      <span className="truncate">{items.join(". ")}</span>
    </span>
  );
}

function LaneCells({
  cells,
  laneTaskIds,
  context,
}: {
  cells: Array<WorkMapLaneCell | null>;
  laneTaskIds: string[];
  context: TreeContext;
}) {
  return (
    <div aria-hidden="true" className="flex self-stretch">
      {cells.map((cell, lane) => {
        const taskId = laneTaskIds[lane];
        const fill = IDENTITY_FILL[context.colors.get(taskId) ?? "slate"];
        const dim = context.highlightTaskId !== null && context.highlightTaskId !== taskId;
        return (
          <span key={taskId} className={cx("relative shrink-0", dim && "opacity-30")} style={{ width: LANE_WIDTH_PX }}>
            {cell?.up && <span className={cx("absolute -top-px left-[6px] h-[17px] w-0.5", fill)} />}
            {cell?.down && <span className={cx("absolute bottom-0 left-[6px] top-4 w-0.5", fill)} />}
            {cell?.mark && <IdentitySwatch color={context.colors.get(taskId)} size="md" className="absolute left-[2px] top-[11px]" />}
          </span>
        );
      })}
    </div>
  );
}

function NodeDetail({ node, context }: { node: WorkMapTreeNode; context: TreeContext }) {
  const tasks = node.taskIds
    .map((taskId) => context.taskById.get(taskId))
    .filter((task): task is WorkMapTask => Boolean(task));
  const facts = [node.item.type, node.item.assignedTo, node.item.areaPath].filter(Boolean).join(" · ");
  return (
    <div className={cx(DS.rail, "mb-2 space-y-2 text-xs")}>
      {facts && <div className="text-text-secondary">{facts}</div>}
      {node.pullRequests.length > 0 && (
        <div className="space-y-0.5">
          {node.pullRequests.map((pr) => {
            const status = PR_STATUS_STYLES[pr.status ?? ""];
            return (
              <a
                key={pr.key}
                href={pr.url}
                target="_blank"
                rel="noopener"
                className={cx(DS.row.base, DS.row.interactive, "text-xs")}
              >
                <span className={DS.row.iconSlot}>
                  {status ? <StatusIcon kind={status.status} label={status.label} /> : <GitPullRequest size={12} className="text-text-faint" />}
                </span>
                <span className="shrink-0 tabular-nums text-text-secondary">PR {pr.prId}</span>
                <span className="min-w-0 truncate text-text-primary">{pr.title ?? `Pull request ${pr.prId}`}</span>
                <span className="ml-auto shrink-0 truncate text-text-faint">{pr.repoName ?? ""}</span>
              </a>
            );
          })}
        </div>
      )}
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          onClick={() => context.onSelectTask(task.id)}
          className={cx(DS.row.stacked, "px-1.5 py-1.5 text-xs")}
        >
          <span className="flex items-center gap-1.5">
            <IdentitySwatch color={context.colors.get(task.id)} />
            <span className="min-w-0 truncate font-medium text-text-primary">{task.title}</span>
            {task.status === "archived" && <span className="shrink-0 text-text-faint">Archived</span>}
          </span>
          {(task.nextAction || task.waitingOn) && (
            <span className="mt-0.5 block text-text-secondary">
              {task.nextAction ? `${task.deferred ? "When resumed" : "Next"}: ${task.nextAction}` : `Waiting for: ${task.waitingOn}`}
            </span>
          )}
        </button>
      ))}
      {node.links.length > 0 && (
        <div className="space-y-0.5">
          {node.links.map((link) => {
            const target = context.lookup.get(link.workItemId);
            return (
              <div key={`${link.type}:${link.workItemId}`} className="flex min-w-0 items-center gap-1.5 text-text-secondary">
                <span className="shrink-0">{WORK_MAP_RELATION_LABELS[link.type as keyof typeof WORK_MAP_RELATION_LABELS]}</span>
                <a href={workItemUrl(context, link.workItemId)} target="_blank" rel="noopener" className="shrink-0 tabular-nums text-accent hover:underline">
                  #{link.workItemId}
                </a>
                {target?.title && <span className="min-w-0 truncate">{target.title}</span>}
                {target?.state && <span className="shrink-0 text-text-faint">{target.state}</span>}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a href={node.item.url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-accent hover:underline">
          Open #{node.id} in ADO <ExternalLink size={11} />
        </a>
        <button
          type="button"
          disabled={context.creatingTaskForWorkItemId !== null}
          onClick={() => context.createTaskFor([node.item])}
          className={cx(DS.focus, "inline-flex items-center gap-1 rounded-sm text-text-secondary hover:text-text-primary disabled:text-text-faint")}
        >
          <Plus size={11} /> New Bridge task for #{node.id}
        </button>
        <button
          type="button"
          onClick={() => context.selectRow(node.id, { range: false, additive: true })}
          className={cx(DS.focus, "rounded-sm text-text-secondary hover:text-text-primary")}
        >
          {context.selected.has(node.id) ? "Deselect" : "Select"}
        </button>
      </div>
    </div>
  );
}

function ItemRow({
  row,
  index,
  lanes,
  context,
}: {
  row: WorkMapTreeRow;
  index: number;
  lanes: ReturnType<typeof layoutWorkMapLanes>;
  context: TreeContext;
}) {
  const { node, depth } = row;
  const parent = node.parentId ? context.nodeById.get(node.parentId) : undefined;
  const attention = treeNodeAttention(node, parent, context.lookup);
  const expanded = context.expanded.has(node.id);
  const dim = context.highlightTaskId !== null && !node.taskIds.includes(context.highlightTaskId);
  const runStarts = lanes.runStarts.get(index) ?? [];
  const closed = isClosedState(node.item.state);
  const selected = context.selected.has(node.id);
  // An untracked map item asks for a task outright; a row that only places other work, such as a
  // feature above linked tasks, offers one on hover.
  const needsTask = node.mapItem !== null && node.taskIds.length === 0 && !closed;
  const offersTask = !needsTask && node.taskIds.length === 0 && runStarts.length === 0 && !closed;
  const hasAnnotations = attention.length > 0 || node.links.length > 0 || node.hiddenChildCount > 0;
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const selectGesture = isSelectGesture(event);
    if (target.closest("a, input") || (target.closest("button") && !target.closest("[data-row-title]"))) return;
    if (selectGesture) {
      event.preventDefault();
      context.selectRow(node.id, { range: event.shiftKey, additive: event.ctrlKey || event.metaKey || event.shiftKey });
    } else if (context.selected.size > 0 && !target.closest("[data-row-title]")) {
      context.selectRow(node.id, { range: false, additive: true });
    }
  };
  // Shift-click would otherwise select the text between the anchor and this row.
  const onRowMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.shiftKey) event.preventDefault();
  };
  const state = (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
      <StatusIcon kind={stateStatus(node.item.state)} decorative />
      <span className="truncate">{node.item.state ?? "Unknown"}</span>
    </span>
  );
  const title = (
    <button
      type="button"
      data-row-title=""
      aria-expanded={expanded}
      onClick={(event) => {
        if (isSelectGesture(event)) return;
        context.toggleExpanded(node.id);
      }}
      className={cx(DS.focus, "min-w-[7rem] truncate rounded-sm text-left text-[13px] hover:underline", titleTone(node))}
      title={node.item.title ?? undefined}
    >
      {node.item.title ?? `Work item ${node.id}`}
    </button>
  );

  return (
    <div
      id={rowElementId(node.id)}
      data-work-map-row={node.id}
      data-selected={selected ? "" : undefined}
      onClick={onRowClick}
      onMouseDown={onRowMouseDown}
      className={cx("group/row scroll-mt-24 transition-opacity", selected && DS.row.selected, dim && "opacity-40")}
    >
      <div className="hidden gap-x-3 px-3 md:grid" style={{ gridTemplateColumns: context.gridColumns }}>
        <div className="flex min-h-8 min-w-0 items-center gap-1.5">
          <SelectBox node={node} context={context} />
          <IndentGuides depth={depth} />
          <CollapseToggle node={node} context={context} />
          <TypeIcon item={node.item} />
          <span className="shrink-0 text-xs tabular-nums text-text-faint">{node.id}</span>
          {title}
          {hasAnnotations && (
            <span className="flex h-4 min-w-[9rem] flex-1 basis-0 flex-wrap items-center gap-x-1.5 overflow-hidden leading-4">
              <Attention items={attention} />
              <RowAnnotations node={node} context={context} />
            </span>
          )}
        </div>
        <div className="flex min-h-8 items-center">{state}</div>
        <div className="flex min-h-8 items-center text-xs tabular-nums text-text-secondary">{pullRequestSummary(node.pullRequests)}</div>
        <div className={cx("flex", expanded && "row-span-2")}>
          <LaneCells cells={lanes.cells[index]} laneTaskIds={lanes.laneTaskIds} context={context} />
        </div>
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-1 py-0.5">
          {runStarts.map((taskId) => <TaskLink key={taskId} taskId={taskId} context={context} showPlacements />)}
          {needsTask && <CreateTaskButton item={node.item} context={context} />}
          {offersTask && <CreateTaskButton item={node.item} context={context} revealOnHover />}
        </div>
        {expanded && (
          <div className="col-span-3 min-w-0" style={{ paddingLeft: depth * 16 + 42 }}>
            <NodeDetail node={node} context={context} />
          </div>
        )}
      </div>

      <div className="py-2 pr-3 md:hidden" style={{ paddingLeft: 12 + Math.min(depth, 4) * 12 }}>
        <div className="flex min-h-6 min-w-0 items-center gap-1.5">
          {context.selected.size > 0 && <SelectBox node={node} context={context} />}
          <CollapseToggle node={node} context={context} />
          <TypeIcon item={node.item} />
          <span className="shrink-0 text-xs tabular-nums text-text-faint">{node.id}</span>
          {state}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-secondary">{pullRequestSummary(node.pullRequests)}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 pl-[22px]">{title}</div>
        {(node.taskIds.length > 0 || node.links.length > 0 || node.hiddenChildCount > 0 || attention.length > 0 || needsTask) && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-[22px]">
            {node.taskIds.map((taskId) => <TaskLink key={taskId} taskId={taskId} context={context} showPlacements={false} />)}
            {needsTask && <CreateTaskButton item={node.item} context={context} />}
            <RowAnnotations node={node} context={context} />
            <Attention items={attention} />
          </div>
        )}
        {expanded && <div className="pl-[22px]"><NodeDetail node={node} context={context} /></div>}
      </div>
    </div>
  );
}

function sectionTitle(section: WorkMapTreeSection): ReactNode {
  if (section.kind === "unparented") return "Not under a parent in ADO";
  const root = section.nodes[0];
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TypeIcon item={root.item} />
      <span className="shrink-0">{root.item.type ?? "Work item"} {root.id}</span>
      <span className="min-w-0 truncate font-normal text-text-secondary">{root.item.title}</span>
    </span>
  );
}

function countItems(nodes: WorkMapTreeNode[]): { onMap: number; context: number } {
  let onMap = 0;
  let context = 0;
  const visit = (node: WorkMapTreeNode) => {
    if (node.mapItem) onMap++;
    else context++;
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return { onMap, context };
}

function OrphanPullRequests({
  orphans,
  context,
}: {
  orphans: WorkMapTreeProps["orphanPullRequests"];
  context: TreeContext;
}) {
  if (orphans.length === 0) return null;
  return (
    <section aria-label="Pull requests without a work item" className={cx(DS.surface.group, "overflow-hidden")} data-ds-surface="group">
      <div className={cx(DS.collection.header, "gap-2 px-3 text-xs font-medium text-text-primary")}>
        Pull requests without a work item
        <span className="font-normal tabular-nums text-text-faint">{orphans.length}</span>
      </div>
      <div className={DS.surface.divided}>
        {orphans.map(({ pullRequest, tasks }) => {
          const status = PR_STATUS_STYLES[pullRequest.status ?? ""];
          return (
            <div key={pullRequest.key} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1">
              <span className={DS.row.iconSlot}>
                {status ? <StatusIcon kind={status.status} label={status.label} /> : <GitPullRequest size={12} className="text-text-faint" />}
              </span>
              <a href={pullRequest.url} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate text-[13px] text-text-primary hover:underline">
                <span className="tabular-nums text-text-faint">PR {pullRequest.prId} </span>
                {pullRequest.title ?? `Pull request ${pullRequest.prId}`}
              </a>
              <span className="shrink-0 text-xs text-text-faint">{pullRequest.repoName ?? ""}</span>
              <span className="flex min-w-0 flex-wrap gap-x-1">
                {tasks.map((task) => <TaskLink key={task.id} taskId={task.id} context={context} showPlacements={false} />)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The work map drawn as the ADO hierarchy, with one lane per Bridge task beside the rows. A square
 * marks a work item the task links; the line joins it to the linked items beneath it.
 */
export default function WorkMapTree({
  data,
  visibleWorkItemIds,
  orphanPullRequests,
  creatingTaskForWorkItemId,
  onSelectTask,
  onCreateTaskForWorkItems,
}: WorkMapTreeProps) {
  const sections = useMemo(() => buildWorkMapTree(data, visibleWorkItemIds), [data, visibleWorkItemIds]);
  const colors = useMemo(() => assignTaskColors(sections), [sections]);
  const placements = useMemo(() => countTaskPlacements(sections), [sections]);
  const lookup = useMemo(() => buildWorkItemLookup(data), [data]);
  const taskById = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);
  const nodeById = useMemo(() => {
    const map = new Map<string, WorkMapTreeNode>();
    const visit = (node: WorkMapTreeNode) => {
      map.set(node.id, node);
      node.children.forEach(visit);
    };
    sections.forEach((section) => section.nodes.forEach(visit));
    return map;
  }, [sections]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null);
  const [rowBudget, setRowBudget] = useState(ROW_STEP);
  const [selection, setSelection] = useState<{ ids: ReadonlySet<string>; anchorId: string | null }>(
    () => ({ ids: new Set(), anchorId: null }),
  );

  useEffect(() => {
    setRowBudget(ROW_STEP);
  }, [visibleWorkItemIds]);

  const laidOut = useMemo(() => {
    let remaining = rowBudget;
    return sections.map((section) => {
      const rows = flattenWorkMapTree(section.nodes, collapsed);
      const shownRows = rows.slice(0, Math.max(0, remaining));
      remaining -= shownRows.length;
      return { section, rows, shownRows, lanes: layoutWorkMapLanes(rows, collapsed, MAX_LANES) };
    });
  }, [sections, collapsed, rowBudget]);
  const rowOrder = useMemo(
    () => laidOut.flatMap(({ shownRows }) => shownRows.map((row) => row.node.id)),
    [laidOut],
  );
  // Rows filtered off the map drop out of the selection; rows under a collapsed parent stay in it.
  const selected = useMemo(
    () => new Set([...selection.ids].filter((id) => nodeById.has(id))),
    [selection.ids, nodeById],
  );

  const selectRow = useCallback((id: string, gesture: RowSelectGesture) => {
    setSelection((current) => {
      const anchorIndex = current.anchorId ? rowOrder.indexOf(current.anchorId) : -1;
      const index = rowOrder.indexOf(id);
      if (gesture.range && anchorIndex >= 0 && index >= 0) {
        const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
        return {
          ids: new Set([...current.ids, ...rowOrder.slice(from, to + 1)]),
          anchorId: current.anchorId,
        };
      }
      const next = new Set(gesture.additive ? current.ids : []);
      if (next.has(id) && gesture.additive) next.delete(id);
      else next.add(id);
      return { ids: next, anchorId: id };
    });
  }, [rowOrder]);
  const clearSelection = useCallback(() => setSelection({ ids: new Set(), anchorId: null }), []);

  useEffect(() => {
    if (selected.size === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, selected.size]);

  const createTaskFor = (workItems: EnrichedWorkItem[]) => {
    void onCreateTaskForWorkItems(workItems).then((created) => {
      if (created) clearSelection();
    });
  };
  const selectedItems = [
    ...rowOrder.filter((id) => selected.has(id)),
    ...[...selected].filter((id) => !rowOrder.includes(id)),
  ].map((id) => nodeById.get(id)!.item);

  const toggle = (setter: typeof setCollapsed) => (id: string) => setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const context: Omit<TreeContext, "gridColumns"> = {
    data,
    lookup,
    nodeById,
    taskById,
    colors,
    placements,
    collapsed,
    expanded,
    selected,
    highlightTaskId,
    creatingTaskForWorkItemId,
    toggleCollapsed: toggle(setCollapsed),
    toggleExpanded: toggle(setExpanded),
    selectRow,
    setHighlightTaskId,
    onSelectTask,
    createTaskFor,
  };

  const totalRows = laidOut.reduce((sum, entry) => sum + entry.rows.length, 0);

  return (
    <div className="space-y-3">
      {laidOut.map(({ section, shownRows, lanes }) => {
        if (shownRows.length === 0) return null;
        const counts = countItems(section.nodes);
        const laneWidth = Math.max(1, lanes.laneTaskIds.length) * LANE_WIDTH_PX;
        const sectionContext: TreeContext = {
          ...context,
          gridColumns: `minmax(0,1fr) 6.5rem 7rem ${laneWidth}px 15rem`,
        };
        return (
          <section
            key={section.key}
            aria-label={section.kind === "unparented" ? "Work items not under a parent" : `Work under ${section.nodes[0].item.type ?? "work item"} ${section.key}`}
            className={cx(DS.surface.group, "overflow-hidden")}
            data-ds-surface="group"
          >
            <div className={cx(DS.collection.header, "gap-3 px-3 text-xs font-medium text-text-primary")}>
              <span className="min-w-0 flex-1">{sectionTitle(section)}</span>
              <span className="shrink-0 font-normal tabular-nums text-text-faint">
                {counts.onMap} linked · {section.taskIds.length} Bridge task{section.taskIds.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="hidden gap-x-3 border-b border-border-subtle px-3 py-1 text-[11px] text-text-faint md:grid" style={{ gridTemplateColumns: sectionContext.gridColumns }}>
              <div>Work item</div>
              <div>State</div>
              <div>Pull requests</div>
              <div />
              <div>Bridge tasks</div>
            </div>
            <div className={DS.surface.divided}>
              {shownRows.map((row, index) => (
                <ItemRow key={row.node.id} row={row} index={index} lanes={lanes} context={sectionContext} />
              ))}
            </div>
          </section>
        );
      })}
      {rowBudget < totalRows && (
        <button
          type="button"
          onClick={() => setRowBudget((budget) => budget + ROW_STEP)}
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "mx-auto flex")}
        >
          Show {Math.min(ROW_STEP, totalRows - rowBudget)} more rows
        </button>
      )}
      <OrphanPullRequests orphans={orphanPullRequests} context={{ ...context, gridColumns: "" }} />
      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Selected work items"
          className={cx(DS.surface.floating, "sticky bottom-3 z-10 mx-auto flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2")}
        >
          <span className="text-[13px] font-medium tabular-nums text-text-primary">
            {selected.size} work item{selected.size === 1 ? "" : "s"} selected
          </span>
          <span className="hidden min-w-0 max-w-[24rem] truncate text-xs tabular-nums text-text-faint sm:inline" title={selectedItems.map((item) => `#${item.id} ${item.title ?? ""}`).join("\n")}>
            {selectedItems.map((item) => `#${item.id}`).join(", ")}
          </span>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={12} />}
            disabled={creatingTaskForWorkItemId !== null}
            onClick={() => createTaskFor(selectedItems)}
          >
            {creatingTaskForWorkItemId !== null ? "Creating..." : "Create Bridge task"}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection} title="Clear the selection (Esc)">
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
