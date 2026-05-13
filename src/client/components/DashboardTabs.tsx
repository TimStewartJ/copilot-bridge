import { CheckSquare, Inbox } from "lucide-react";
import type { DashboardTab } from "../lib/dashboard-routes";

interface DashboardTabsProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  checklistCount: number;
  checklistCountClass: string;
  checklistCountTitle?: string;
  feedCount: number;
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
  checklistCount,
  checklistCountClass,
  checklistCountTitle,
  feedCount,
}: DashboardTabsProps) {
  return (
    <div className="flex rounded-lg border border-border bg-bg-surface p-1" role="tablist" aria-label="Dashboard sections">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "checklist"}
        onClick={() => onTabChange("checklist")}
        className={tabClass(activeTab === "checklist")}
      >
        <CheckSquare size={14} />
        <span>Checklist</span>
        {checklistCount > 0 && (
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[11px] font-semibold leading-none ${checklistCountClass}`}
            title={checklistCountTitle}
          >
            {checklistCount}
          </span>
        )}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "feed"}
        onClick={() => onTabChange("feed")}
        className={tabClass(activeTab === "feed")}
      >
        <Inbox size={14} />
        <span>Feed</span>
        {feedCount > 0 && (
          <span className="rounded-full border border-border bg-bg-hover px-1.5 py-0.5 text-[11px] font-semibold leading-none text-text-faint">
            {feedCount}
          </span>
        )}
      </button>
    </div>
  );
}
