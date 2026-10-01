import { useLocation, useNavigate } from "react-router-dom";
import type { EnrichedWorkItem, Task, TaskGroup } from "../api";
import { useSettingsQuery } from "../hooks/queries/useSettings";
import { useWorkMapQuery } from "../hooks/queries/useWorkMap";
import { useWorkMapFilters } from "../work-map-filter-state";
import NativeHome from "./NativeHome";
import AllTasks from "./AllTasks";
import { useIsMobile } from "../useIsMobile";
import { ALL_TASKS_PATH } from "../lib/dashboard-routes";
import DashboardWorkMap from "./DashboardWorkMap";
import { Button } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import type { PullToRefreshScrollRestoration } from "./PullToRefresh";

interface DashboardProps {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onCreateTaskForWorkItems: (workItems: EnrichedWorkItem[]) => Promise<void>;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onStartPromptSession: (prompt: string, taskId?: string, options?: { navigateOnError?: boolean }) => Promise<string>;
  tasks?: Task[]; taskGroups?: TaskGroup[];
  scrollRestoration?: PullToRefreshScrollRestoration;
}
export default function Dashboard(props: DashboardProps) {
  const navigate = useNavigate(), location = useLocation();
  const { data: settings } = useSettingsQuery();
  const mapActive = location.pathname === "/dashboard/work-map";
  const tasksActive = location.pathname === ALL_TASKS_PATH;
  const isMobile = useIsMobile();
  const [mapFilters, changeMapFilters] = useWorkMapFilters();
  const map = useWorkMapQuery(mapActive && !!settings?.providers?.ado, mapFilters.includeArchived, mapFilters.assignedToMeOnly);
  return <div className="flex flex-1 min-h-0 flex-col">
    {settings?.providers?.ado && <nav aria-label="Home and work map" className={cx(DS.surface.pane, "flex shrink-0 gap-2 border-b border-border px-4 py-2")}>
      <Button variant="ghost" size="sm" aria-current={!mapActive && !tasksActive ? "page" : undefined} onClick={() => navigate("/dashboard/home")}>Home</Button>
      <Button variant="ghost" size="sm" aria-current={tasksActive ? "page" : undefined} onClick={() => navigate(ALL_TASKS_PATH)}>All tasks</Button>
      <Button id="dashboard-work-map-tab" aria-controls="dashboard-work-map-panel" variant="ghost" size="sm" aria-current={mapActive ? "page" : undefined} onClick={() => navigate("/dashboard/work-map")}>Work map</Button>
    </nav>}
    {mapActive ? <div className="flex-1 min-h-0 overflow-auto"><div className={cx(DS.layout.pageColumn, "max-w-7xl")}>
      <DashboardWorkMap map={map} filters={mapFilters} onFiltersChange={changeMapFilters}
        onSelectTask={props.onSelectTask} onCreateTaskForWorkItems={props.onCreateTaskForWorkItems} />
    </div></div> : tasksActive ? <AllTasks compact={isMobile} onBack={() => navigate("/dashboard/home")} onSelectTask={id => props.onSelectTask(id)} scrollRestoration={props.scrollRestoration} /> : <NativeHome onSelectTask={props.onSelectTask} onSelectSession={props.onSelectSession} scrollRestoration={props.scrollRestoration} />}
  </div>;
}
