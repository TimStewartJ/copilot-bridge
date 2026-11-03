import { useEffect, useId, useState } from "react";
import { BookMarked } from "lucide-react";
import { patchTask, type Task } from "../api";
import { DS, cx } from "../design/tokens";
import { usePlaybooksQuery } from "../hooks/queries/usePlaybooks";
import PlaybookSelect from "./shared/PlaybookSelect";

/** The playbook this task pins for its chats, chosen in place among the task's details. */
export default function TaskPlaybookRow({ task, onTasksChanged }: {
  task: Pick<Task, "id" | "playbook">;
  onTasksChanged?: () => void;
}) {
  const id = useId();
  const playbooksQuery = usePlaybooksQuery();
  const [saving, setSaving] = useState(false);
  // Shown until the refreshed task arrives, so the select does not jump back meanwhile.
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [task.playbook]);
  const [error, setError] = useState<string | null>(null);

  const save = async (playbook: string) => {
    setSaving(true);
    setError(null);
    setChosen(playbook);
    try {
      await patchTask(task.id, { playbook: playbook || null });
      onTasksChanged?.();
    } catch (err) {
      setChosen(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0">
      <div className={cx("-mx-1.5 flex min-w-0 items-center gap-2 px-1.5 py-1", DS.row.touch)}>
        <span className={cx(DS.row.iconSlot, "text-text-faint")}><BookMarked size={14} aria-hidden="true" /></span>
        <label htmlFor={id} className="shrink-0 @[18rem]/task-details:w-[5.25rem] truncate text-xs text-text-muted">Playbook</label>
        <PlaybookSelect
          id={id}
          inputSize="sm"
          className="min-w-0 flex-1"
          playbooks={playbooksQuery.data ?? []}
          value={chosen ?? task.playbook ?? ""}
          emptyLabel="None"
          disabled={saving}
          aria-describedby={error ? `${id}-error` : undefined}
          onValueChange={(value) => void save(value)}
        />
      </div>
      {error && <p id={`${id}-error`} role="alert" className="pl-7 text-xs text-error">{error}</p>}
    </div>
  );
}
