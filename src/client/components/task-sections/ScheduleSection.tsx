import type { Schedule } from "../../api";
import { timeAgo } from "../../time";
import { Clock, Plus } from "lucide-react";
import CollapsibleCompleted from "../shared/CollapsibleCompleted";
import EmptyState from "../shared/EmptyState";
import TaskPanelSummaryRow, { type TaskPanelSummaryChip } from "../TaskPanelSummaryRow";
import ScheduleRow from "./ScheduleRow";

// ── Props ────────────────────────────────────────────────────────

export interface ScheduleSectionProps {
  schedules: Schedule[];
  variant?: "compact" | "card" | "summary";
  label?: React.ReactNode;
  onAdd?: () => void;
  onOpen: (schedule: Schedule) => void;
  onTrigger?: (id: string) => void;
  onToggle?: (schedule: Schedule) => void;
  onEdit?: (schedule: Schedule) => void;
  onDelete?: (id: string) => void;
  emptyMessage?: string;
}

function toTime(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? fallback : time;
}

function getSchedulePriority(schedule: Schedule): number {
  if (schedule.enabled && schedule.nextRunAt) return 0;
  if (schedule.enabled) return 1;
  return 2;
}

function compareSchedules(a: Schedule, b: Schedule): number {
  const priorityDiff = getSchedulePriority(a) - getSchedulePriority(b);
  if (priorityDiff !== 0) return priorityDiff;

  const nextDiff = toTime(a.nextRunAt, Number.MAX_SAFE_INTEGER) - toTime(b.nextRunAt, Number.MAX_SAFE_INTEGER);
  if (nextDiff !== 0) return nextDiff;

  const runDiff = toTime(a.runAt, Number.MAX_SAFE_INTEGER) - toTime(b.runAt, Number.MAX_SAFE_INTEGER);
  if (runDiff !== 0) return runDiff;

  const lastDiff = toTime(b.lastRunAt, 0) - toTime(a.lastRunAt, 0);
  if (lastDiff !== 0) return lastDiff;

  return b.updatedAt.localeCompare(a.updatedAt);
}

function getScheduleSummary(schedule: Schedule): string {
  if (!schedule.enabled) {
    return schedule.lastRunAt ? `Paused · last run ${timeAgo(schedule.lastRunAt)}` : "Paused";
  }
  if (schedule.nextRunAt) return `Next ${timeAgo(schedule.nextRunAt)}`;
  if (schedule.lastRunAt) return `Last run ${timeAgo(schedule.lastRunAt)}`;
  if (schedule.type === "once" && schedule.runAt) return `Runs ${timeAgo(schedule.runAt)}`;
  return schedule.type === "cron" ? "Recurring schedule" : "Scheduled run";
}

// ── Component ────────────────────────────────────────────────────

export default function ScheduleSection({
  schedules,
  variant = "compact",
  label,
  onAdd,
  onOpen,
  onTrigger,
  onToggle,
  onEdit,
  onDelete,
  emptyMessage = "No schedules",
}: ScheduleSectionProps) {
  const activeSchedules = schedules.filter((s) => s.enabled);
  const disabledSchedules = schedules.filter((s) => !s.enabled);
  const isCompact = variant === "compact";

  if (variant === "summary") {
    if (schedules.length === 0) return null;

    const primarySchedule = [...schedules].sort(compareSchedules)[0];
    const chips: TaskPanelSummaryChip[] = [];

    if (activeSchedules.length > 0) {
      chips.push({ label: `${activeSchedules.length} active`, className: "bg-accent/15 text-accent" });
    }
    if (disabledSchedules.length > 0) {
      chips.push({ label: `${disabledSchedules.length} paused`, className: "bg-text-muted/15 text-text-muted" });
    }

    const title = schedules.length === 1
      ? primarySchedule.name
      : activeSchedules.length === 0
        ? `${schedules.length} paused schedules`
        : `${schedules.length} schedules`;

    const subtitle = schedules.length === 1
      ? getScheduleSummary(primarySchedule)
      : primarySchedule.enabled
        ? primarySchedule.nextRunAt
          ? `Next: ${primarySchedule.name} · ${timeAgo(primarySchedule.nextRunAt)}`
          : `${primarySchedule.name} · ${getScheduleSummary(primarySchedule)}`
        : `All paused · ${primarySchedule.name}`;

    return (
      <TaskPanelSummaryRow
        label="Schedules"
        icon={<Clock size={14} className={primarySchedule.enabled ? "text-accent" : "text-text-faint"} />}
        title={title}
        subtitle={subtitle}
        chips={chips}
        onClick={() => onOpen(primarySchedule)}
        trailing={onAdd ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            className="p-1 text-text-faint hover:text-accent transition-colors"
            title="Add schedule"
          >
            <Plus size={12} />
          </button>
        ) : undefined}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between px-3 py-1">
        {label}
        {onAdd && (
          <button
            onClick={onAdd}
            className="text-[10px] text-accent hover:text-accent-hover transition-colors flex items-center gap-0.5"
            title="Add schedule"
          >
            <Plus size={10} />
            <span>Add</span>
          </button>
        )}
      </div>
      {schedules.length > 0 ? (
        <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
          {activeSchedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              variant={variant}
              onOpen={onOpen}
              onTrigger={onTrigger}
              onToggle={onToggle}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
          <CollapsibleCompleted count={disabledSchedules.length} label="disabled">
            {disabledSchedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                variant={variant}
                onOpen={onOpen}
                onTrigger={onTrigger}
                onToggle={onToggle}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </CollapsibleCompleted>
        </div>
      ) : (
        <EmptyState
          message={emptyMessage}
          sub="Add one to automate recurring work"
        />
      )}
    </div>
  );
}
