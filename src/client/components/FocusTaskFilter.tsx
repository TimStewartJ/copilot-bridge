import { focusTaskChoiceLabel, type FocusTaskChoice } from "../focus-filter-helpers";

export default function FocusTaskFilter({ label, value, choices, onChange }: {
  label: "Task" | "Original task";
  value: string | undefined;
  choices: FocusTaskChoice[];
  onChange: (value: string) => void;
}) {
  const fieldClass = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-border bg-bg-surface px-3 text-sm text-text-primary";
  return <div className="min-w-0">
    <label className="block min-w-0 text-xs text-text-muted">
      <span>{label}</span>
      <select name={label === "Task" ? "taskId" : "originalTaskId"} value={value ?? ""} onChange={(event) => onChange(event.target.value)} className={fieldClass}>
        <option value="">{label === "Task" ? "All task scopes" : "Any original task"}</option>
        {value && !choices.some((choice) => choice.id === value) && <option value={value}>{focusTaskChoiceLabel(value, choices)}</option>}
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{focusTaskChoiceLabel(choice.id, choices)}</option>)}
      </select>
    </label>
    <details className="text-xs text-text-muted">
      <summary className="min-h-11 cursor-pointer py-3">Exact {label.toLowerCase()} identifier</summary>
      <label className="block">
        <span>{label} ID</span>
        <input name={label === "Task" ? "taskId-exact" : "originalTaskId-exact"} value={value ?? ""} onChange={(event) => onChange(event.target.value)} className={fieldClass} />
      </label>
      <p className="mt-1 text-text-faint">Known labels are suggestions, not a complete inventory. Retained or off-page tasks can still be found by exact ID.</p>
    </details>
  </div>;
}
