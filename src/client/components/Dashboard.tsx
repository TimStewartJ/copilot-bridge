import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Task, TaskGroup, WorkMapWorkItem } from "../api";
import { useSettingsQuery } from "../hooks/queries/useSettings";
import { useWorkMapQuery } from "../hooks/queries/useWorkMap";
import { loadWorkMapFilters } from "../work-map-filter-state";
import NativeHome from "./NativeHome";
import DashboardWorkMap from "./DashboardWorkMap";
import { Button } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import type { PullToRefreshScrollRestoration } from "./PullToRefresh";

interface DashboardProps {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onCreateTaskForWorkItem: (workItem: WorkMapWorkItem) => Promise<void>;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onStartPromptSession: (prompt: string, taskId?: string, options?: { navigateOnError?: boolean }) => Promise<string>;
  tasks?: Task[]; taskGroups?: TaskGroup[];
  scrollRestoration?: PullToRefreshScrollRestoration;
}
export default function Dashboard(props: DashboardProps) {
  const navigate = useNavigate(), location = useLocation();
  const { data: settings } = useSettingsQuery();
  const mapActive = location.pathname === "/dashboard/work-map";
  const [includeArchived, setIncludeArchived] = useState(() => loadWorkMapFilters().includeArchived);
  const [assignedToMe, setAssignedToMe] = useState(() => loadWorkMapFilters().assignedToMeOnly);
  const map = useWorkMapQuery(mapActive && !!settings?.providers?.ado, includeArchived, assignedToMe);
  return <div className="flex flex-1 min-h-0 flex-col">
    {settings?.providers?.ado && <nav aria-label="Home and work map" className={cx(DS.surface.pane, "flex shrink-0 gap-2 border-b border-border px-4 py-2")}>
      <Button variant="ghost" size="sm" aria-current={!mapActive ? "page" : undefined} onClick={() => navigate("/dashboard/home")}>Home</Button>
      <Button id="dashboard-work-map-tab" aria-controls="dashboard-work-map-panel" variant="ghost" size="sm" aria-current={mapActive ? "page" : undefined} onClick={() => navigate("/dashboard/work-map")}>Work map</Button>
    </nav>}
    {mapActive ? <div className="flex-1 min-h-0 overflow-auto"><div className={cx(DS.layout.pageColumn, "max-w-6xl")}>
      <DashboardWorkMap active data={map.data} isLoading={map.isLoading} error={map.error} isRefreshing={map.isRefreshing}
        onRefresh={map.refresh} includeArchived={includeArchived} onIncludeArchivedChange={setIncludeArchived}
        assignedToMeOnly={assignedToMe} onAssignedToMeChange={setAssignedToMe}
        onSelectTask={props.onSelectTask} onCreateTaskForWorkItem={props.onCreateTaskForWorkItem} />
    </div></div> : <NativeHome onSelectTask={props.onSelectTask} onSelectSession={props.onSelectSession} scrollRestoration={props.scrollRestoration} />}
  </div>;
}
