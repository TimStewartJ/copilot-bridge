import type { Schedule } from "../../api";
import { Plus } from "lucide-react";
import CollapsibleCompleted from "../shared/CollapsibleCompleted";
import EmptyState from "../shared/EmptyState";
import ScheduleRow from "./ScheduleRow";

// ── Props ────────────────────────────────────────────────────────

export interface ScheduleSectionProps {
  schedules: Schedule[];
  variant?: "compact" | "card";
  label?: React.ReactNode;
  onAdd?: () => void;
  onOpen: (schedule: Schedule) => void;
  onTrigger?: (id: string) => void;
  onToggle?: (schedule: Schedule) => void;
  onEdit?: (schedule: Schedule) => void;
  onDelete?: (id: string) => void;
  emptyMessage?: string;
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
