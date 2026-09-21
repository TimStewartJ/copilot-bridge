import type { Task } from "../api";
import { getTaskKindLabel } from "../task-kind";
import { Pin } from "lucide-react";
import { SegmentedControl } from "../design/primitives";

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
    <SegmentedControl
      ariaLabel="Task kind"
      size="sm"
      value={kind}
      onChange={onChange}
      disabled={disabled}
      options={KIND_OPTIONS.map((option) => ({
        value: option,
        label: getTaskKindLabel(option),
        icon: option === "ongoing" ? <Pin size={10} className="rotate-45" aria-hidden="true" /> : undefined,
      }))}
    />
  );
}