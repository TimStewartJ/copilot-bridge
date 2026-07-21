import type { Schedule } from "../../api";
import { timeAgo } from "../../time";
import {
  Clock,
  Play,
  Pause,
  Trash2,
  MoreHorizontal,
} from "lucide-react";

// ── Props ────────────────────────────────────────────────────────

export interface ScheduleRowProps {
  schedule: Schedule & { taskTitle?: string | null; taskId?: string };
  variant?: "compact" | "card";
  onOpen: (schedule: Schedule) => void;
  onTrigger?: (id: string) => void;
  onToggle?: (schedule: Schedule) => void;
  onEdit?: (schedule: Schedule) => void;
  onDelete?: (id: string) => void;
  onSelectTask?: (taskId: string) => void;
}

// ── Component ────────────────────────────────────────────────────

export default function ScheduleRow({
  schedule,
  variant = "compact",
  onOpen,
  onTrigger,
  onToggle,
  onEdit,
  onDelete,
  onSelectTask,
}: ScheduleRowProps) {
  const isCompact = variant === "compact";
  const iconSize = isCompact ? 12 : 14;
  const buttonSize = isCompact ? 10 : 12;

  return (
    <div
      className={`${
        isCompact
          ? "px-3 py-1.5 text-xs hover:bg-bg-hover rounded-md"
          : "px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover"
      } transition-colors group`}
    >
      <div className={`flex items-center ${isCompact ? "gap-1.5" : "gap-2"}`}>
        <Clock size={iconSize} className={schedule.enabled ? "text-info" : "text-text-faint"} />
        <button
          onClick={() => onOpen(schedule)}
          className={`${isCompact ? "font-medium" : "text-sm font-medium"} truncate flex-1 text-left hover:text-accent transition-colors ${
            schedule.enabled ? "text-text-primary" : "text-text-faint line-through"
          }`}
        >
          {schedule.name}
        </button>
        <div className={`flex items-center ${isCompact ? "gap-0.5" : "gap-1"}`}>
          {onTrigger && (
            <button
              onClick={() => onTrigger(schedule.id)}
              className={`${isCompact ? "p-0.5" : "p-1"} text-text-muted hover:text-success transition-colors`}
              title="Run now"
            >
              <Play size={buttonSize} />
            </button>
          )}
          {onToggle && (
            <button
              onClick={() => onToggle(schedule)}
              className={`${isCompact ? "p-0.5" : "p-1"} text-text-muted hover:text-warning transition-colors`}
              title={schedule.enabled ? "Pause" : "Resume"}
            >
              {schedule.enabled ? <Pause size={buttonSize} /> : <Play size={buttonSize} />}
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(schedule)}
              className={`${isCompact ? "p-0.5" : "p-1"} text-text-muted hover:text-text-primary transition-colors hidden group-hover:block`}
              title="Edit"
            >
              <MoreHorizontal size={buttonSize} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(schedule.id)}
              className={`${isCompact ? "p-0.5" : "p-1"} text-text-muted hover:text-error transition-colors hidden group-hover:block`}
              title="Delete"
            >
              <Trash2 size={buttonSize} />
            </button>
          )}
        </div>
      </div>

      {/* Task link + cron details (Dashboard variant) */}
      {onSelectTask && (
        <div className={`${isCompact ? "text-[10px] mt-0.5 ml-5" : "text-xs mt-1 ml-6"} flex items-center gap-2 flex-wrap text-text-muted`}>
          {schedule.taskTitle && (
            <button
              onClick={(e) => { e.stopPropagation(); onSelectTask(schedule.taskId!); }}
              className="text-accent hover:text-accent-hover transition-colors truncate max-w-[150px]"
            >
              {schedule.taskTitle}
            </button>
          )}
          <span className="text-text-faint">
            {schedule.type === "cron" ? schedule.cron : `Once at ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`}
            {schedule.type === "cron" && schedule.timezone && ` (${schedule.timezone.replace(/^.*\//, "").replace(/_/g, " ")})`}
          </span>
        </div>
      )}

      {/* Schedule details (non-Dashboard compact) */}
      {!onSelectTask && isCompact && (
        <div className="mt-0.5 ml-5 text-[10px] text-text-faint">
          {schedule.type === "cron" ? schedule.cron : `Once at ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`}
          {schedule.type === "cron" && schedule.timezone && ` (${schedule.timezone.replace(/^.*\//, "").replace(/_/g, " ")})`}
          {schedule.lastRunAt && ` · Last: ${timeAgo(schedule.lastRunAt)}`}
          {schedule.enabled && schedule.nextRunAt && ` · Next: ${timeAgo(schedule.nextRunAt)}`}
          {schedule.runCount > 0 && ` · ${schedule.runCount} run${schedule.runCount !== 1 ? "s" : ""}`}
        </div>
      )}

      {!onSelectTask && !isCompact && (
        <>
          <div className="text-xs text-text-muted mt-1 ml-6">
            {schedule.type === "cron" ? schedule.cron : `Once at ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`}
            {schedule.type === "cron" && schedule.timezone && (
              <span className="ml-1 opacity-60" title={schedule.timezone}>({schedule.timezone.replace(/^.*\//, "").replace(/_/g, " ")})</span>
            )}
          </div>
          <div className="text-[10px] text-text-faint mt-0.5 ml-6 flex items-center gap-2">
            {schedule.lastRunAt && <span>Last: {timeAgo(schedule.lastRunAt)}</span>}
            {schedule.enabled && schedule.nextRunAt && <span>Next: {timeAgo(schedule.nextRunAt)}</span>}
            {schedule.runCount > 0 && <span>{schedule.runCount} run{schedule.runCount !== 1 ? "s" : ""}</span>}
          </div>
        </>
      )}

      {/* Dashboard variant: run stats below task link */}
      {onSelectTask && (
        <div className={`text-[10px] text-text-faint ${isCompact ? "mt-0.5 ml-5" : "mt-0.5 ml-6"} flex items-center gap-2`}>
          {schedule.lastRunAt && <span>Last: {timeAgo(schedule.lastRunAt)}</span>}
          {schedule.enabled && schedule.nextRunAt && <span>Next: {timeAgo(schedule.nextRunAt)}</span>}
          {schedule.runCount > 0 && <span>{schedule.runCount} run{schedule.runCount !== 1 ? "s" : ""}</span>}
        </div>
      )}
    </div>
  );
}
