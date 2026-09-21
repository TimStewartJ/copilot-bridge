import { BookOpen, Layers, LayoutDashboard, Settings, ShipWheel, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { describeHomeChecklistIndicator, type HomeChecklistIndicator } from "../checklist-helpers";
import {
  describeTabAttention,
  type TabAttentionSummary,
} from "../hooks/useTaskIndicators";
import type { MobileNavTab } from "../lib/mobile-route-meta";
import { DS, cx } from "../design/tokens";
import { CountBadge } from "../design/primitives";

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
              className={cx("flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors", DS.focus, active ? "text-text-primary" : "text-text-muted active:text-text-secondary")}
            >
              <span className={cx("flex h-7 w-14 items-center justify-center rounded-lg transition-colors", active && DS.row.selected)}>
                <span className="relative flex">
                  <Icon size={20} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
                  {attention.count > 0 && (
                    <CountBadge
                      count={attention.count}
                      tone={attention.needsUserInputCount > 0 ? "warning" : "success"}
                      className="absolute -right-3.5 -top-1.5 ring-2 ring-bg-secondary"
                    />
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
