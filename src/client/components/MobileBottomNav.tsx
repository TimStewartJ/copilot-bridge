import { LayoutDashboard, ListTodo, MessageSquare, BookOpen, Settings } from "lucide-react";
import { useMemo } from "react";
import { describeHomeTodoIndicator, type HomeTodoIndicator } from "../todo-helpers";

type Tab = "home" | "tasks" | "chats" | "docs" | "settings";

interface MobileBottomNavProps {
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  homeTodoIndicator?: HomeTodoIndicator;
  taskUnreadCount?: number;
  chatUnreadCount?: number;
  showDocs?: boolean;
}

const isStandalone = typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches ||
   (navigator as unknown as { standalone?: boolean }).standalone === true);

export function MobileBottomNav({
  activeTab,
  onSelectTab,
  homeTodoIndicator = { state: "none", dueTodayCount: 0, overdueCount: 0, urgentCount: 0 },
  taskUnreadCount = 0,
  chatUnreadCount = 0,
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
      style={isStandalone ? undefined : { paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          const unreadCount = id === "tasks"
            ? taskUnreadCount
            : id === "chats"
              ? chatUnreadCount
              : 0;
          const homeIndicatorDescription = id === "home"
            ? describeHomeTodoIndicator(homeTodoIndicator)
            : null;
          const homeIndicatorDotClass = homeTodoIndicator.state === "overdue"
            ? "bg-error"
            : homeTodoIndicator.state === "due-today"
              ? "bg-warning"
              : "";
          return (
            <button
              key={id}
              onClick={() => onSelectTab(id)}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors ${active ? "text-accent" : "text-text-muted active:text-text-secondary"}`}
              aria-label={homeIndicatorDescription ? `${label}, ${homeIndicatorDescription}` : label}
            >
              <span className="relative">
                <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
                {unreadCount > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-accent text-white text-[10px] font-semibold leading-none">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
                {unreadCount === 0 && id === "home" && homeTodoIndicator.state !== "none" && (
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
