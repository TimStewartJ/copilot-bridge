// Shared deadline/checklist helpers used by TaskPanel and Dashboard

export type DeadlineUrgency = "none" | "soon" | "overdue";
export type HomeChecklistIndicatorState = "none" | "due-today" | "overdue";

export interface HomeChecklistIndicator {
  state: HomeChecklistIndicatorState;
  dueTodayCount: number;
  overdueCount: number;
  urgentCount: number;
}

interface DeadlineLike {
  deadline?: string;
  done?: boolean;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function deadlineUrgency(deadline: string | undefined, done: boolean): DeadlineUrgency {
  if (!deadline || done) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dl = new Date(deadline + "T00:00:00");
  const diffDays = (dl.getTime() - today.getTime()) / 86_400_000;
  if (diffDays < 0) return "overdue";
  if (diffDays <= 2) return "soon";
  return "none";
}

export function deadlineLabel(deadline: string): string {
  const d = new Date(deadline + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function getHomeChecklistIndicator(
  checklistItems: readonly DeadlineLike[],
  now = new Date(),
): HomeChecklistIndicator {
  const today = localDateKey(now);
  let overdueCount = 0;
  let dueTodayCount = 0;

  for (const checklistItem of checklistItems) {
    if (!checklistItem.deadline || checklistItem.done) continue;
    if (checklistItem.deadline < today) overdueCount++;
    else if (checklistItem.deadline === today) dueTodayCount++;
  }

  return {
    state: overdueCount > 0 ? "overdue" : dueTodayCount > 0 ? "due-today" : "none",
    dueTodayCount,
    overdueCount,
    urgentCount: overdueCount + dueTodayCount,
  };
}

export function describeHomeChecklistIndicator(indicator: HomeChecklistIndicator): string | null {
  if (indicator.state === "overdue") {
    return `${indicator.overdueCount} overdue checklist item${indicator.overdueCount === 1 ? "" : "s"}`;
  }
  if (indicator.state === "due-today") {
    return `${indicator.dueTodayCount} checklist item${indicator.dueTodayCount === 1 ? "" : "s"} due today`;
  }
  return null;
}

export const DEADLINE_STYLES: Record<DeadlineUrgency, string> = {
  none: "text-text-faint",
  soon: "text-warning",
  overdue: "text-error",
};

export const CHECKBOX_URGENCY: Record<DeadlineUrgency, string> = {
  none: "border-text-faint hover:border-accent",
  soon: "border-warning hover:border-warning",
  overdue: "border-error hover:border-error",
};
