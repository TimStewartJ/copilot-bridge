import type { Task } from "../api";
import { getTaskKindLabel } from "../task-kind";
import { Pin } from "lucide-react";

const KIND_OPTIONS: Task["kind"][] = ["task", "ongoing"];

interface TaskKindSwitcherProps {
  kind: Task["kind"];
  onChange: (kind: Task["kind"]) => void;
  disabled?: boolean;
}

export default function TaskKindSwitcher({
  kind,
  onChange,
  disabled = false,
}: TaskKindSwitcherProps) {
  return (
    <div
      role="group"
      aria-label="Task kind"
      className={`inline-flex items-center rounded-full border border-border bg-bg-surface p-0.5 ${disabled ? "opacity-60" : ""}`}
    >
      {KIND_OPTIONS.map((option) => {
        const selected = option === kind;

        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(option);
            }}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              selected
                ? "bg-bg-hover text-text-primary"
                : "text-text-faint hover:text-text-secondary"
            } disabled:cursor-default`}
          >
            {option === "ongoing" && <Pin size={10} className="rotate-45" aria-hidden="true" />}
            {getTaskKindLabel(option)}
          </button>
        );
      })}
    </div>
  );
}
