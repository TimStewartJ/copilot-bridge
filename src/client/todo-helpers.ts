// Shared deadline/todo helpers used by TaskPanel and Dashboard

export type DeadlineUrgency = "none" | "soon" | "overdue";

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
