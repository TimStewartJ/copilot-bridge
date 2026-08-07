import { LayoutDashboard, ListTodo, MessageSquare, BookOpen, Settings } from "lucide-react";
import { useMemo } from "react";
import { describeHomeChecklistIndicator, type HomeChecklistIndicator } from "../checklist-helpers";
import {
  describeTabAttention,
  type TabAttentionSummary,
} from "../hooks/useTaskIndicators";

type Tab = "home" | "tasks" | "chats" | "docs" | "settings";

interface MobileBottomNavProps {
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  homeChecklistIndicator?: HomeChecklistIndicator;
  taskAttention?: TabAttentionSummary;
  chatAttention?: TabAttentionSummary;
  showDocs?: boolean;
}

export function MobileBottomNav({
  activeTab,
  onSelectTab,
  homeChecklistIndicator = { state: "none", dueTodayCount: 0, overdueCount: 0, urgentCount: 0 },
  taskAttention = { count: 0, needsUserInputCount: 0 },
  chatAttention = { count: 0, needsUserInputCount: 0 },
  showDocs = true,
}: MobileBottomNavProps) {
  const tabs: { id: Tab; label: string; icon: typeof ListTodo }[] = useMemo(() => [
    { id: "home", label: "Home", icon: LayoutDashboard },
    { id: "tasks", label: "Tasks", icon: ListTodo },
    { id: "chats", label: "Chats", icon: MessageSquare },
    ...(showDocs ? [{ id: "docs" as Tab, label: "Docs", icon: BookOpen }] : []),
    { id: "settings", label: "Settings", icon: Settings },
  ], [showDocs]);

  return (
    <nav
      className="md:hidden shrink-0 bg-bg-secondary border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          const attention = id === "tasks"
            ? taskAttention
            : id === "chats"
              ? chatAttention
              : { count: 0, needsUserInputCount: 0 };
          const attentionDescription = id === "tasks"
            ? describeTabAttention(attention, "task", "tasks")
            : id === "chats"
              ? describeTabAttention(attention, "chat", "chats")
              : null;
          const homeIndicatorDescription = id === "home"
            ? describeHomeChecklistIndicator(homeChecklistIndicator)
            : null;
          const homeIndicatorDotClass = homeChecklistIndicator.state === "overdue"
            ? "bg-error"
            : homeChecklistIndicator.state === "due-today"
              ? "bg-warning"
              : "";
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectTab(id)}
              className={`flex h-full flex-1 flex-col items-center justify-center gap-0.5 transition-colors ${active ? "text-accent" : "text-text-muted active:text-text-secondary"}`}
              aria-label={
                homeIndicatorDescription
                  ? `${label}, ${homeIndicatorDescription}`
                  : attentionDescription
                    ? `${label}, ${attentionDescription}`
                    : label
              }
            >
              <span className={`relative rounded-full p-1 transition-colors ${active ? "bg-accent-surface" : ""}`}>
                <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
                {attention.count > 0 && (
                  <span
                    aria-hidden="true"
                    className={`absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full text-white text-[10px] font-semibold leading-none ${
                      attention.needsUserInputCount > 0 ? "bg-warning" : "bg-success"
                    }`}
                  >
                    {attention.count > 99 ? "99+" : attention.count}
                  </span>
                )}
                {attention.count === 0 && id === "home" && homeChecklistIndicator.state !== "none" && (
                  <span
                    aria-hidden="true"
                    className={`absolute -top-0.5 -right-1 h-2.5 w-2.5 rounded-full ring-2 ring-bg-secondary ${homeIndicatorDotClass}`}
                  />
                )}
              </span>
              <span className={`text-[10px] leading-tight ${active ? "font-semibold" : "font-medium"}`}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
