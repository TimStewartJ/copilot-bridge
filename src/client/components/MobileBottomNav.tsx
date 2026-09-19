import { BookOpen, Layers, LayoutDashboard, Settings, ShipWheel, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { describeHomeChecklistIndicator, type HomeChecklistIndicator } from "../checklist-helpers";
import {
  describeTabAttention,
  type TabAttentionSummary,
} from "../hooks/useTaskIndicators";
import type { MobileNavTab } from "../lib/mobile-route-meta";

interface MobileBottomNavProps {
  activeTab: MobileNavTab;
  onSelectTab: (tab: MobileNavTab) => void;
  homeChecklistIndicator?: HomeChecklistIndicator;
  taskAttention?: TabAttentionSummary;
  chatAttention?: TabAttentionSummary;
  showDocs?: boolean;
}

const NO_ATTENTION: TabAttentionSummary = { count: 0, needsUserInputCount: 0 };

export function MobileBottomNav({
  activeTab,
  onSelectTab,
  homeChecklistIndicator = { state: "none", dueTodayCount: 0, overdueCount: 0, urgentCount: 0 },
  taskAttention = NO_ATTENTION,
  chatAttention = NO_ATTENTION,
  showDocs = true,
}: MobileBottomNavProps) {
  const tabs: { id: MobileNavTab; label: string; icon: LucideIcon }[] = useMemo(() => [
    { id: "home", label: "Home", icon: LayoutDashboard },
    { id: "work", label: "Work", icon: Layers },
    { id: "helm", label: "Helm", icon: ShipWheel },
    ...(showDocs ? [{ id: "docs" as MobileNavTab, label: "Docs", icon: BookOpen }] : []),
    { id: "settings", label: "Settings", icon: Settings },
  ], [showDocs]);

  // Work holds both the task list and the quick chats, so its badge answers for both.
  const workAttention: TabAttentionSummary = {
    count: taskAttention.count + chatAttention.count,
    needsUserInputCount: taskAttention.needsUserInputCount + chatAttention.needsUserInputCount,
  };
  const workAttentionDescription = [
    describeTabAttention(taskAttention, "task", "tasks"),
    describeTabAttention(chatAttention, "chat", "chats"),
  ].filter((part): part is string => part !== null).join(". ") || null;
  const homeIndicatorDescription = describeHomeChecklistIndicator(homeChecklistIndicator);
  const homeIndicatorDotClass = homeChecklistIndicator.state === "overdue"
    ? "bg-error"
    : homeChecklistIndicator.state === "due-today"
      ? "bg-warning"
      : "";

  return (
    <nav
      aria-label="Primary"
      className="md:hidden shrink-0 bg-bg-secondary border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex h-14 max-w-xl items-stretch justify-around px-1">
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          const attention = id === "work" ? workAttention : NO_ATTENTION;
          const description = id === "home"
            ? homeIndicatorDescription
            : id === "work"
              ? workAttentionDescription
              : null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectTab(id)}
              aria-current={active ? "page" : undefined}
              aria-label={description ? `${label}, ${description}` : label}
              className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 transition-colors ${active ? "text-accent" : "text-text-muted active:text-text-secondary"}`}
            >
              <span className={`flex h-7 w-14 items-center justify-center rounded-full transition-colors ${active ? "bg-accent-surface" : ""}`}>
                <span className="relative flex">
                  <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
                  {attention.count > 0 && (
                    <span
                      aria-hidden="true"
                      className={`absolute -top-1.5 -right-3.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full text-white text-[10px] font-semibold leading-none ring-2 ring-bg-secondary ${
                        attention.needsUserInputCount > 0 ? "bg-warning" : "bg-success"
                      }`}
                    >
                      {attention.count > 99 ? "99+" : attention.count}
                    </span>
                  )}
                  {id === "home" && homeChecklistIndicator.state !== "none" && (
                    <span
                      aria-hidden="true"
                      className={`absolute -top-1 -right-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-bg-secondary ${homeIndicatorDotClass}`}
                    />
                  )}
                </span>
              </span>
              <span className={`text-[11px] leading-tight ${active ? "font-semibold" : "font-medium"}`}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
