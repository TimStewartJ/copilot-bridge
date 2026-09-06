import { ListTodo, Workflow } from "lucide-react";
import {
  getDashboardPanelId,
  getDashboardTabId,
  type DashboardTab,
} from "../lib/dashboard-routes";

interface DashboardTabsProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  focusCount: number;
  focusCountClass: string;
  focusCountTitle?: string;
  showWorkMap?: boolean;
  workMapCount?: number;
}

function tabClass(selected: boolean): string {
  return `flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
    selected
      ? "bg-bg-primary text-text-primary shadow-sm"
      : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
  }`;
}

export default function DashboardTabs({
  activeTab,
  onTabChange,
  focusCount,
  focusCountClass,
  focusCountTitle,
  showWorkMap = false,
  workMapCount,
}: DashboardTabsProps) {
  if (!showWorkMap) return null;

  return (
    <div className="flex rounded-lg border border-border bg-bg-surface p-1" role="tablist" aria-label="Dashboard sections">
      <button
        type="button"
        role="tab"
        id={getDashboardTabId("focus")}
        aria-controls={getDashboardPanelId("focus")}
        aria-selected={activeTab === "focus"}
        onClick={() => onTabChange("focus")}
        className={tabClass(activeTab === "focus")}
      >
        <ListTodo size={14} />
        <span>Focus</span>
        {focusCount > 0 && (
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[11px] font-semibold leading-none ${focusCountClass}`}
            title={focusCountTitle}
          >
            {focusCount > 99 ? "99+" : focusCount}
          </span>
        )}
      </button>
      <button
        type="button"
        role="tab"
        id={getDashboardTabId("work-map")}
        aria-controls={getDashboardPanelId("work-map")}
        aria-selected={activeTab === "work-map"}
        onClick={() => onTabChange("work-map")}
        className={tabClass(activeTab === "work-map")}
      >
        <Workflow size={14} />
        <span>Work map</span>
        {workMapCount !== undefined && workMapCount > 0 && (
          <span className="rounded-full border border-border bg-bg-hover px-1.5 py-0.5 text-[11px] font-semibold leading-none text-text-faint">
            {workMapCount}
          </span>
        )}
      </button>
    </div>
  );
}
