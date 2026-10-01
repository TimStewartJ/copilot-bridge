import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronRight, ClipboardList, ExternalLink, GitPullRequest, Plus } from "lucide-react";
import type { EnrichedWorkItem, WorkMapPullRequest, WorkMapTask } from "../api";
import { Button, IdentitySwatch, StatusIcon } from "../design/primitives";
import { IDENTITY_FILL, type IdentityColor } from "../design/identity";
import { DS, cx } from "../design/tokens";
import { prefersReducedMotion } from "../lib/motion";
import { isClosedWorkItemState } from "../../shared/work-map.js";
import { PR_STATUS_STYLES, WI_TYPE_ICONS } from "../work-item-styles";
import {
  assignTaskColors,
  buildWorkMapTree,
  countTaskPlacements,
  flattenWorkMapTree,
  layoutWorkMapLanes,
  NO_SELECTION,
  rowClickSelects,
  selectRow,
  UNREADABLE,
  WORK_MAP_RELATION_LABELS,
  type WorkMapLaneCell,
  type WorkMapModel,
  type WorkMapOrphan,
  type WorkMapTreeNode,
  type WorkMapTreeRow,
  type WorkMapTreeSection,
} from "../work-map-model";

const MAX_LANES = 6;
const LANE_WIDTH_PX = 14;
const ROW_STEP = 150;
const VISIBLE_LINKS = 2;

interface WorkMapTreeProps {
  model: WorkMapModel;
  visibleWorkItemIds: ReadonlySet<string>;
  orphans: WorkMapOrphan[];
  /** Where to open a linked work item the map has no details for. */
  org: string | null;
  project: string | null;
  /** A task is being created, so a second one cannot be started. */
  creating: boolean;
  onSelectTask: (taskId: string) => void;
  /** Resolves true when the task was created. */
  onCreateTaskForWorkItems: (workItems: EnrichedWorkItem[]) => Promise<boolean>;
}

interface TreeContext {
  model: WorkMapModel;
  workItemUrl: (id: string) => string;
  colors: Map<string, IdentityColor>;
  placements: Map<string, number>;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  highlightTaskId: string | null;
  creating: boolean;
  /** The desktop row grid; the lane column is as wide as the section's lanes. */
  gridColumns: string;
  toggleCollapsed: (id: string) => void;
  toggleExpanded: (id: string) => void;
  /** Toggles a row in the selection, or with `range` adds every row up to the last clicked one. */
  selectRow: (id: string, range: boolean) => void;
  setHighlightTaskId: (taskId: string | null) => void;
  onSelectTask: (taskId: string) => void;
  createTaskFor: (workItems: EnrichedWorkItem[]) => void;
}

function isSelectGesture(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}

function rowElementId(id: string): string {
  return `work-map-row-${id}`;
}

function stateStatus(state: string | null): "done" | "closed" | "open" {
  if (!isClosedWorkItemState(state)) return "open";
  return state?.toLowerCase() === "removed" ? "closed" : "done";
}

function titleTone(node: WorkMapTreeNode): string {
  if (isClosedWorkItemState(node.item.state)) return "text-text-faint";
  return node.mapItem ? "text-text-primary" : "text-text-secondary";
}

function pullRequestSummary(pullRequests: WorkMapPullRequest[]): ReactNode {
  if (pullRequests.length === 0) return null;
  const active = pullRequests.filter((pr) => pr.status === "active").length;
  // One element, so the space before the dot survives in a flex row.
  return (
    <span>
      {pullRequests.length} PR{pullRequests.length === 1 ? "" : "s"}
      {active > 0 && <span className="text-text-primary"> · {active} active</span>}
    </span>
  );
}

/** `decorative` is for an icon beside text that already names the type. */
function TypeIcon({ item, decorative = false }: { item: EnrichedWorkItem; decorative?: boolean }) {
  const typeInfo = WI_TYPE_ICONS[item.type ?? ""];
  const type = item.type ?? "Work item";
  return (
    <span aria-hidden={decorative || undefined} className={cx(DS.row.iconSlot, typeInfo?.color ?? "text-text-muted")} title={type}>
      {typeInfo?.icon ?? <ClipboardList size={12} />}
      {!decorative && <span className="sr-only">{type}</span>}
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
  if (node.children.length === 0) return <span aria-hidden="true" className="w-4 shrink-0" />;
  const open = !context.collapsed.has(node.id);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} children of work item ${node.id}`}
      onClick={() => context.toggleCollapsed(node.id)}
      // The chevron stays small in the row; on a phone its tap area reaches 40px around it.
      className={cx(
        DS.focus,
        "relative flex h-6 w-4 shrink-0 items-center justify-center rounded-sm text-text-faint hover:text-text-primary",
        "max-md:before:absolute max-md:before:-bottom-1 max-md:before:-left-2 max-md:before:-right-4 max-md:before:-top-3 max-md:before:content-['']",
      )}
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
  const task = context.model.taskById.get(taskId);
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
      className={cx(DS.row.inline, DS.row.interactive, "text-xs")}
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
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<Plus size={12} />}
      aria-label={`Create Bridge task for work item ${item.id}`}
      title={`Create a Bridge task linked to ${item.type ?? "work item"} ${item.id}`}
      disabled={context.creating}
      onClick={() => context.createTaskFor([item])}
      className={cx(revealOnHover
        && "pointer-events-none opacity-0 focus-visible:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100")}
    >
      Task
    </Button>
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
        context.selectRow(node.id, event.shiftKey);
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
 * ADO children that are not shown as counts. The expanded row lists the links in full.
 */
function RowAnnotations({ node, context }: { node: WorkMapTreeNode; context: TreeContext }) {
  const named = node.links.filter((link) => link.type !== "related");
  const shown = named.slice(0, VISIBLE_LINKS);
  const related = node.links.filter((link) => link.type === "related");
  const unnamed = named.length - shown.length;
  const relatedTitle = related
    .map((link) => {
      const target = context.model.entries.get(link.workItemId)?.item;
      return target?.title ? `#${link.workItemId} ${target.title}` : `#${link.workItemId}`;
    })
    .join("\n");
  return (
    <>
      {shown.map((link) => {
        const target = context.model.entries.get(link.workItemId)?.item;
        const label = WORK_MAP_RELATION_LABELS[link.type as keyof typeof WORK_MAP_RELATION_LABELS];
        const warning = link.type === "predecessor" && target?.state != null && !isClosedWorkItemState(target.state);
        return (
          <a
            key={`${link.type}:${link.workItemId}`}
            href={context.workItemUrl(link.workItemId)}
            target="_blank"
            rel="noopener"
            onClick={(event) => {
              // A link to a row that is on screen scrolls to it; any other opens the work item in ADO.
              const row = document.getElementById(rowElementId(link.workItemId));
              if (!row || isSelectGesture(event)) return;
              event.preventDefault();
              row.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
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
          title={`${node.hiddenChildCount} more child item${node.hiddenChildCount === 1 ? "" : "s"} in ADO ${node.hiddenChildCount === 1 ? "is" : "are"} not shown here`}
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

/** A pull request on one line: its state, number and title, then the repository. */
function PullRequestLine({ pullRequest }: { pullRequest: WorkMapPullRequest }) {
  const status = PR_STATUS_STYLES[pullRequest.status ?? ""];
  const repository = pullRequest.repoName ?? "";
  return (
    <>
      <span className={DS.row.iconSlot}>
        {status ? <StatusIcon kind={status.status} label={status.label} /> : <GitPullRequest size={12} className="text-text-faint" />}
      </span>
      <a href={pullRequest.url} target="_blank" rel="noopener" className={cx(DS.focus, "min-w-0 flex-1 truncate rounded-sm text-[13px] text-text-primary hover:underline")}>
        <span className="tabular-nums text-text-secondary">PR {pullRequest.prId} </span>
        {pullRequest.title ?? <span className={DS.tone.warning}>{UNREADABLE}</span>}
      </a>
      {/* Left out on a phone, where the title needs the line. A link saved from another organization names its repository by URL. */}
      <span className="max-w-[40%] shrink-0 truncate text-xs text-text-faint max-md:hidden" title={repository}>
        {/\/_git\/([^/]+)\/?$/.exec(repository)?.[1] ?? repository}
      </span>
    </>
  );
}

function NodeDetail({ node, context }: { node: WorkMapTreeNode; context: TreeContext }) {
  const tasks = node.taskIds.flatMap((taskId) => context.model.taskById.get(taskId) ?? []);
  const facts = [node.item.type, node.item.assignedTo, node.item.areaPath].filter(Boolean).join(" · ");
  return (
    <div className={cx(DS.rail, "mb-2 space-y-2 text-xs")}>
      {facts && <div className="text-text-secondary">{facts}</div>}
      {node.pullRequests.length > 0 && (
        <div className="space-y-0.5">
          {node.pullRequests.map((pr) => (
            <div key={pr.key} className="flex min-h-6 min-w-0 items-center gap-2">
              <PullRequestLine pullRequest={pr} />
            </div>
          ))}
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
            const target = context.model.entries.get(link.workItemId)?.item;
            return (
              <div key={`${link.type}:${link.workItemId}`} className="flex min-w-0 items-center gap-1.5 text-text-secondary">
                <span className="shrink-0">{WORK_MAP_RELATION_LABELS[link.type as keyof typeof WORK_MAP_RELATION_LABELS]}</span>
                <a href={context.workItemUrl(link.workItemId)} target="_blank" rel="noopener" className="shrink-0 tabular-nums text-accent hover:underline">
                  #{link.workItemId}
                </a>
                {target?.title && <span className="min-w-0 truncate">{target.title}</span>}
                {target?.state && <span className="shrink-0 text-text-faint">{target.state}</span>}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <a href={node.item.url} target="_blank" rel="noopener" className="mr-2 inline-flex items-center gap-1 text-accent hover:underline">
          Open #{node.id} in ADO <ExternalLink size={11} />
        </a>
        <Button variant="ghost" size="sm" icon={<Plus size={12} />} disabled={context.creating} onClick={() => context.createTaskFor([node.item])}>
          New Bridge task for #{node.id}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => context.selectRow(node.id, false)}>
          {context.selected.has(node.id) ? "Deselect" : "Select"}
        </Button>
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
  const expanded = context.expanded.has(node.id);
  const dim = context.highlightTaskId !== null && !node.taskIds.includes(context.highlightTaskId);
  const runStarts = lanes.runStarts.get(index) ?? [];
  const selected = context.selected.has(node.id);
  // Open work with no task asks for one outright; a row that only places other work, such as a
  // feature above linked tasks, offers one on hover.
  const offersTask = !node.needsTask && node.taskIds.length === 0 && runStarts.length === 0
    && node.item.title !== null && !isClosedWorkItemState(node.item.state);
  const hasAnnotations = node.attention.length > 0 || node.links.length > 0 || node.hiddenChildCount > 0;
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const clicked = target.closest("[data-row-title]") ? "title" : target.closest("a, input, button") ? "control" : "row";
    const select = rowClickSelects(clicked, event, context.selected.size > 0);
    if (!select) return;
    event.preventDefault();
    context.selectRow(node.id, select.range);
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
              <Attention items={node.attention} />
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
          {node.needsTask && <CreateTaskButton item={node.item} context={context} />}
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
        {(node.taskIds.length > 0 || hasAnnotations || node.needsTask) && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-[22px]">
            {node.taskIds.map((taskId) => <TaskLink key={taskId} taskId={taskId} context={context} showPlacements={false} />)}
            {node.needsTask && <CreateTaskButton item={node.item} context={context} />}
            <RowAnnotations node={node} context={context} />
            <Attention items={node.attention} />
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
      <TypeIcon item={root.item} decorative />
      <span className="shrink-0">{root.item.type ?? "Work item"} {root.id}</span>
      <span className="min-w-0 truncate font-normal text-text-secondary">{root.item.title}</span>
    </span>
  );
}

/** The work items in a section that are on the map, leaving out the ancestors shown to place them. */
function countMapItems(nodes: WorkMapTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.mapItem ? 1 : 0) + countMapItems(node.children), 0);
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function OrphanPullRequests({ orphans, context }: { orphans: WorkMapOrphan[]; context: TreeContext }) {
  if (orphans.length === 0) return null;
  return (
    <section aria-label="Pull requests without a work item" className={cx(DS.surface.group, "overflow-hidden")} data-ds-surface="group">
      <div className={cx(DS.collection.header, "gap-2 px-3 text-xs font-medium text-text-primary")}>
        Pull requests without a work item
        <span className="font-normal tabular-nums text-text-faint">{orphans.length}</span>
      </div>
      <div className={DS.surface.divided}>
        {orphans.map(({ pullRequest, tasks }) => (
          <div key={pullRequest.key} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1">
            {/* The title keeps room to be read: tasks that do not fit beside it go on the next line. */}
            <span className="flex min-w-[min(100%,20rem)] flex-1 items-center gap-2">
              <PullRequestLine pullRequest={pullRequest} />
            </span>
            <span className="flex min-w-0 flex-wrap gap-x-1">
              {tasks.map((task) => <TaskLink key={task.id} taskId={task.id} context={context} showPlacements={false} />)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The work map drawn as the ADO hierarchy, with one lane per Bridge task beside the rows. A square
 * marks a work item the task links; the line joins it to the linked items beneath it.
 */
export default function WorkMapTree({
  model,
  visibleWorkItemIds,
  orphans,
  org,
  project,
  creating,
  onSelectTask,
  onCreateTaskForWorkItems,
}: WorkMapTreeProps) {
  const sections = useMemo(() => buildWorkMapTree(model, visibleWorkItemIds), [model, visibleWorkItemIds]);
  const colors = useMemo(() => assignTaskColors(sections, MAX_LANES), [sections]);
  const placements = useMemo(() => countTaskPlacements(sections), [sections]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null);
  const [rowBudget, setRowBudget] = useState(ROW_STEP);
  const [selection, setSelection] = useState(NO_SELECTION);

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
  const selected = useMemo(() => {
    const onTree = new Set(sections.flatMap((section) => flattenWorkMapTree(section.nodes, new Set()).map((row) => row.node.id)));
    return new Set([...selection.ids].filter((id) => onTree.has(id)));
  }, [selection.ids, sections]);

  const select = useCallback(
    (id: string, range: boolean) => setSelection((current) => selectRow(current, rowOrder, id, range)),
    [rowOrder],
  );
  const clearSelection = useCallback(() => setSelection(NO_SELECTION), []);

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
  // In the order the rows are on screen, then any selected row that is under a collapsed parent.
  const selectedItems = [
    ...rowOrder.filter((id) => selected.has(id)),
    ...[...selected].filter((id) => !rowOrder.includes(id)),
  ].map((id) => model.entries.get(id)!.item);

  const toggle = (setter: typeof setCollapsed) => (id: string) => setter((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const context: TreeContext = {
    model,
    workItemUrl: (id) => model.entries.get(id)?.item.url ?? `https://${org}.visualstudio.com/${project}/_workitems/edit/${id}`,
    colors,
    placements,
    collapsed,
    expanded,
    selected,
    highlightTaskId,
    creating,
    gridColumns: "",
    toggleCollapsed: toggle(setCollapsed),
    toggleExpanded: toggle(setExpanded),
    selectRow: select,
    setHighlightTaskId,
    onSelectTask,
    createTaskFor,
  };

  const totalRows = laidOut.reduce((sum, entry) => sum + entry.rows.length, 0);

  return (
    <div className="space-y-3">
      {laidOut.map(({ section, shownRows, lanes }) => {
        if (shownRows.length === 0) return null;
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
                {plural(countMapItems(section.nodes), "work item")} · {plural(section.taskIds.length, "Bridge task")}
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
        <Button size="sm" className="mx-auto flex" onClick={() => setRowBudget((budget) => budget + ROW_STEP)}>
          Show {Math.min(ROW_STEP, totalRows - rowBudget)} more rows
        </Button>
      )}
      <OrphanPullRequests orphans={orphans} context={context} />
      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Selected work items"
          className={cx(DS.surface.floating, "sticky bottom-3 z-10 mx-auto flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2")}
        >
          <span className="text-[13px] font-medium tabular-nums text-text-primary">
            {selected.size}
            <span className="max-sm:hidden"> work item{selected.size === 1 ? "" : "s"}</span> selected
          </span>
          <span className="hidden min-w-0 max-w-[24rem] truncate text-xs tabular-nums text-text-faint sm:inline" title={selectedItems.map((item) => `#${item.id} ${item.title ?? ""}`).join("\n")}>
            {selectedItems.map((item) => `#${item.id}`).join(", ")}
          </span>
          <Button variant="primary" size="sm" icon={<Plus size={12} />} disabled={creating} onClick={() => createTaskFor(selectedItems)}>
            {creating ? "Creating..." : "Create Bridge task"}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection} title="Clear the selection (Esc)">
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
