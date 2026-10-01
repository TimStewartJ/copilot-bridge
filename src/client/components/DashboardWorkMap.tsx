import { useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, Search, Workflow } from "lucide-react";
import type { EnrichedWorkItem, WorkMapProgress } from "../api";
import { timeAgo } from "../time";
import { getDashboardPanelId, getDashboardTabId } from "../lib/dashboard-routes";
import EmptyState from "./shared/EmptyState";
import { LoadingSkeletonRegion, Skeleton } from "./shared/Skeleton";
import { DEFAULT_WORK_MAP_FILTERS, type WorkMapFilters } from "../work-map-filter-state";
import type { WorkMapQuery } from "../hooks/queries/useWorkMap";
import { buildWorkMapModel, filterWorkMap, summarizeWorkMap } from "../work-map-model";
import { DS, cx } from "../design/tokens";
import { Button, ChoiceButton, MetaLine, Notice, StatRow, TextInput } from "../design/primitives";
import WorkMapTree from "./WorkMapTree";

interface DashboardWorkMapProps {
  map: WorkMapQuery;
  filters: WorkMapFilters;
  /** Takes the filters that change. */
  onFiltersChange: (change: Partial<WorkMapFilters>) => void;
  onSelectTask: (taskId: string) => void;
  onCreateTaskForWorkItems: (workItems: EnrichedWorkItem[]) => Promise<void>;
}

const SKELETON_ROWS = [
  { depth: 0, width: "38%" },
  { depth: 1, width: "52%" },
  { depth: 2, width: "44%" },
  { depth: 2, width: "58%" },
  { depth: 2, width: "36%" },
  { depth: 1, width: "48%" },
  { depth: 2, width: "54%" },
  { depth: 0, width: "42%" },
];

/**
 * Stands in for the map while it loads with nothing to show: the step the server is on, how far
 * through the whole build that is, and rows in the shape of the tree that is coming.
 */
function WorkMapLoading({ progress }: { progress: WorkMapProgress | null }) {
  const label = progress?.label ?? "Loading the work map";
  const stepDone = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  const percent = progress ? Math.round(((progress.step - 1 + stepDone) / progress.steps) * 100) : 0;
  return (
    <LoadingSkeletonRegion isLoading label={label} className="space-y-3">
      <div aria-hidden="true" className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className={cx(DS.motion.live, "min-w-0 truncate")}>{label}</span>
          {progress && (
            <span className={cx(DS.text.meta, "shrink-0")}>
              Step {progress.step} of {progress.steps}
              {progress.total > 0 && ` · ${progress.done} of ${progress.total}`}
            </span>
          )}
        </div>
        <div className={DS.meter.track}>
          <div
            className={cx(DS.meter.fill, "transition-[width] duration-300 motion-reduce:transition-none")}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <div aria-hidden="true" className={cx(DS.surface.group, "overflow-hidden")} data-ds-surface="group">
        <div className={cx(DS.collection.header, "px-3")}>
          <Skeleton shape="pill" height={10} width="32%" />
        </div>
        <div className={DS.surface.divided}>
          {SKELETON_ROWS.map((row, index) => (
            <div key={index} className="flex min-h-8 items-center gap-2 pr-3" style={{ paddingLeft: 12 + row.depth * 16 }}>
              <Skeleton shape="square" height={12} width={12} className="shrink-0" />
              <Skeleton shape="pill" height={10} width={row.width} />
              <Skeleton shape="pill" height={10} width={64} className="ml-auto hidden shrink-0 md:block" />
            </div>
          ))}
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

export default function DashboardWorkMap({
  map,
  filters,
  onFiltersChange,
  onSelectTask,
  onCreateTaskForWorkItems,
}: DashboardWorkMapProps) {
  const { data } = map;
  const { search, assignedToMeOnly, openAdoOnly, gapsOnly, includeArchived } = filters;
  const [creating, setCreating] = useState(false);
  const [createTaskError, setCreateTaskError] = useState<string | null>(null);

  const model = useMemo(() => (data?.enabled ? buildWorkMapModel(data) : null), [data]);
  const visible = useMemo(
    () => (model ? filterWorkMap(model, { search, assignedToMeOnly, openAdoOnly, gapsOnly }) : null),
    [model, search, assignedToMeOnly, openAdoOnly, gapsOnly],
  );
  const summary = useMemo(() => (model && visible ? summarizeWorkMap(model, visible) : null), [model, visible]);

  const createTaskForWorkItems = async (workItems: EnrichedWorkItem[]): Promise<boolean> => {
    if (workItems.length === 0) return false;
    setCreating(true);
    setCreateTaskError(null);
    try {
      await onCreateTaskForWorkItems(workItems);
      return true;
    } catch (error) {
      setCreateTaskError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setCreating(false);
    }
  };

  const configured = data?.enabled !== false;
  const hasActiveFilters = Boolean(search || assignedToMeOnly || openAdoOnly || gapsOnly || includeArchived);

  return (
    // Not a tab stop. A click on a row would focus the whole panel, and the Shift press of a
    // range selection would then draw the focus ring around all of it.
    <section
      id={getDashboardPanelId("work-map")}
      role="tabpanel"
      aria-labelledby={getDashboardTabId("work-map")}
      className="space-y-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className={cx(DS.text.sectionLabel, "inline-flex items-center gap-2")}>
            <Workflow size={14} />
            Connected work
          </div>
          <h2 className={cx(DS.text.title, "mt-1")}>Work map</h2>
          <p className={cx(DS.field.help, "mt-1")}>
            ADO work items in their ADO hierarchy, with the pull requests and Bridge tasks linked to them.
          </p>
        </div>
        {configured && (
          <Button
            size="sm"
            icon={<RefreshCw size={12} className={map.isFetching ? "animate-spin motion-reduce:animate-none" : ""} />}
            disabled={map.isFetching}
            onClick={map.refresh}
            className="self-start"
          >
            {map.isFetching ? (data ? "Refreshing..." : "Loading...") : "Refresh ADO"}
          </Button>
        )}
      </div>

      {!configured ? (
        <EmptyState
          message="Azure DevOps is not configured"
          sub="Add an ADO organization and project in Settings to enable the Work Map."
        />
      ) : (
        <>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
              <TextInput
                type="search"
                aria-label="Search the work map"
                value={search}
                onChange={(event) => onFiltersChange({ search: event.target.value })}
                placeholder="Search work items, PRs, or tasks..."
                className="pl-9"
              />
            </div>
            <div role="group" aria-label="Work map filters" className={cx(DS.choice.group, "items-center")}>
              <ChoiceButton
                selected={assignedToMeOnly}
                title={data?.currentUser
                  ? `Show the open work assigned to ${data.currentUser.displayName}`
                  : "Show the open work assigned to the signed-in ADO user"}
                onClick={() => onFiltersChange({ assignedToMeOnly: !assignedToMeOnly })}
              >
                Assigned to me
              </ChoiceButton>
              <ChoiceButton
                selected={openAdoOnly}
                title="Hide closed work items unless one of their pull requests is still active"
                onClick={() => onFiltersChange({ openAdoOnly: !openAdoOnly })}
              >
                Open ADO
              </ChoiceButton>
              <ChoiceButton
                selected={gapsOnly}
                title="Show only what needs attention: open work with no Bridge task, and rows with a warning"
                onClick={() => onFiltersChange({ gapsOnly: !gapsOnly })}
              >
                Gaps only
              </ChoiceButton>
              <ChoiceButton
                selected={includeArchived}
                title="Include the work linked to archived Bridge tasks"
                onClick={() => onFiltersChange({ includeArchived: !includeArchived })}
              >
                Archived tasks
              </ChoiceButton>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={() => onFiltersChange(DEFAULT_WORK_MAP_FILTERS)}>
                  Reset
                </Button>
              )}
            </div>
          </div>

          {!data && map.isFetching && <WorkMapLoading progress={map.progress} />}

          {map.error && !map.isFetching && (
            <Notice
              tone={data ? "warning" : "danger"}
              icon={<AlertTriangle size={14} />}
              title={data ? "The work map could not be refreshed" : "Work map could not be loaded"}
              action={<Button variant="ghost" size="sm" onClick={map.refresh}>Try again</Button>}
            >
              {map.error.message}
              {data && <span className="block">Showing what was loaded {timeAgo(new Date(map.refreshedAt).toISOString())}.</span>}
            </Notice>
          )}

          {data && model && visible && summary && (
            <>
              {data.warnings.length > 0 && (
                <Notice tone="warning" icon={<AlertTriangle size={14} />}>{data.warnings.join(" ")}</Notice>
              )}
              {createTaskError && (
                <Notice tone="danger" icon={<AlertTriangle size={14} />} title="Could not create the Bridge task">
                  {createTaskError}
                </Notice>
              )}

              <StatRow
                stats={[
                  { label: "ADO work items", value: summary.workItems },
                  { label: "Related PRs", value: summary.pullRequests },
                  { label: "Bridge tasks", value: summary.tasks },
                  {
                    label: "Needs attention",
                    value: <span className={summary.attention > 0 ? DS.tone.warning : undefined}>{summary.attention}</span>,
                  },
                ]}
              />

              {data.workItems.length === 0 && data.pullRequests.length === 0 ? (
                <EmptyState
                  message="No linked ADO work yet"
                  sub="Link an ADO work item or pull request to a Bridge task and it will appear here."
                />
              ) : visible.workItemIds.size === 0 && visible.orphans.length === 0 ? (
                <EmptyState
                  message="No work matches these filters"
                  sub="Clear the search or turn off a filter to see more connected work."
                />
              ) : (
                <WorkMapTree
                  model={model}
                  visibleWorkItemIds={visible.workItemIds}
                  orphans={visible.orphans}
                  org={data.org}
                  project={data.project}
                  creating={creating}
                  onSelectTask={onSelectTask}
                  onCreateTaskForWorkItems={createTaskForWorkItems}
                />
              )}

              <MetaLine
                className="justify-end"
                items={[
                  `${data.org}/${data.project}`,
                  includeArchived ? "active and archived tasks" : "active tasks",
                  `refreshed ${timeAgo(new Date(map.refreshedAt).toISOString())}`,
                ]}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
