import { useEffect, useState } from "react";
import type { Task } from "../api";
import { patchTask } from "../api";

type MomentumFieldKey = "doneWhen" | "nextAction" | "waitingOn" | "nextTouchAt";

type FieldValues = Record<MomentumFieldKey, string>;
export type FollowUpState = "overdue" | "due" | "upcoming" | null;

interface TaskMomentumFieldsProps {
  task: Task;
  variant?: "panel" | "dashboard";
  onSaved?: () => void;
  onPatched?: (task: Task) => void;
}

interface FieldConfig {
  key: MomentumFieldKey;
  label: string;
  placeholder: string;
  type: "text" | "datetime-local";
}

const FIELD_CONFIGS: FieldConfig[] = [
  { key: "doneWhen", label: "Done when", placeholder: "Define the finish line", type: "text" },
  { key: "nextAction", label: "Next action", placeholder: "Capture the next concrete step", type: "text" },
  { key: "waitingOn", label: "Waiting on", placeholder: "Who or what is blocking this", type: "text" },
  { key: "nextTouchAt", label: "Follow up on", placeholder: "Pick a follow-up date and time", type: "datetime-local" },
];

export default function TaskMomentumFields({
  task,
  variant = "panel",
  onSaved,
  onPatched,
}: TaskMomentumFieldsProps) {
  const [values, setValues] = useState<FieldValues>(() => toFieldValues(task));
  const [drafts, setDrafts] = useState<FieldValues>(() => toFieldValues(task));
  const [editingField, setEditingField] = useState<MomentumFieldKey | null>(null);
  const [savingField, setSavingField] = useState<MomentumFieldKey | null>(null);

  useEffect(() => {
    const next = toFieldValues(task);
    setValues(next);
    setDrafts(next);
    setEditingField(null);
    setSavingField(null);
  }, [task.id, task.doneWhen, task.nextAction, task.waitingOn, task.nextTouchAt]);

  const isDashboard = variant === "dashboard";

  const persistField = async (field: MomentumFieldKey, rawValue: string) => {
    const normalized = normalizeDraft(field, rawValue);
    if (normalized === values[field]) {
      setEditingField((current) => (current === field ? null : current));
      setDrafts((current) => ({ ...current, [field]: normalized }));
      return;
    }

    let patchValue: string | null;
    try {
      patchValue = serializeFieldValue(field, normalized);
    } catch (error) {
      console.error(`Failed to validate ${field}`, error);
      return;
    }

    const previousValues = values;
    const optimisticValues = { ...values, [field]: normalized };
    setValues(optimisticValues);
    setDrafts(optimisticValues);
    setSavingField(field);
    setEditingField((current) => (current === field ? null : current));

    try {
      const updates: Partial<Record<MomentumFieldKey, string | null>> = { [field]: patchValue };
      const updatedTask = await patchTask(task.id, updates);
      const nextValues = toFieldValues(updatedTask);
      setValues(nextValues);
      setDrafts(nextValues);
      onPatched?.(updatedTask);
      onSaved?.();
    } catch (error) {
      console.error(`Failed to update ${field}`, error);
      setValues(previousValues);
      setDrafts(previousValues);
    } finally {
      setSavingField(null);
    }
  };

  return (
    <div className={isDashboard ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : "space-y-2"}>
      {FIELD_CONFIGS.map((field) => {
        const currentValue = values[field.key];
        const isEditing = editingField === field.key;
        const isSaving = savingField === field.key;

        return (
          <div
            key={field.key}
            className={`rounded-md border border-border bg-bg-surface ${isDashboard ? "px-3 py-2.5" : "px-2.5 py-2"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {field.label}
              </span>
              {isSaving ? (
                <span className="text-[10px] text-text-faint">Saving…</span>
              ) : currentValue && !isEditing ? (
                <button
                  type="button"
                  onClick={() => void persistField(field.key, "")}
                  className="text-[10px] text-text-faint hover:text-text-primary transition-colors"
                >
                  Clear
                </button>
              ) : null}
            </div>

            {isEditing ? (
              <input
                autoFocus
                type={field.type}
                value={drafts[field.key]}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setDrafts((current) => ({ ...current, [field.key]: nextValue }));
                }}
                onBlur={() => {
                  void persistField(field.key, drafts[field.key]);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void persistField(field.key, drafts[field.key]);
                  }
                  if (event.key === "Escape") {
                    setDrafts((current) => ({ ...current, [field.key]: values[field.key] }));
                    setEditingField(null);
                  }
                }}
                className="mt-1 w-full rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
                placeholder={field.placeholder}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDrafts(values);
                  setEditingField(field.key);
                }}
                className={`mt-1 w-full text-left text-xs transition-colors ${
                  currentValue
                    ? "text-text-primary hover:text-accent"
                    : "text-text-faint hover:text-text-muted"
                }`}
                title={currentValue || field.placeholder}
              >
                {field.key === "nextTouchAt"
                  ? (currentValue ? formatFollowUpDisplay(currentValue) : field.placeholder)
                  : (currentValue || field.placeholder)}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function getFollowUpState(nextTouchAt?: string, now = new Date()): FollowUpState {
  if (!nextTouchAt) return null;
  const parsed = new Date(nextTouchAt);
  if (Number.isNaN(parsed.getTime())) return null;

  if (parsed.getTime() > now.getTime()) return "upcoming";
  return parsed.getTime() < startOfLocalDay(now).getTime() ? "overdue" : "due";
}

function toFieldValues(task: Task): FieldValues {
  return {
    doneWhen: task.doneWhen ?? "",
    nextAction: task.nextAction ?? "",
    waitingOn: task.waitingOn ?? "",
    nextTouchAt: toDateTimeInputValue(task.nextTouchAt),
  };
}

function normalizeDraft(field: MomentumFieldKey, value: string): string {
  return field === "nextTouchAt" ? value : value.trim();
}

export function toDateTimeInputValue(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const localValue = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return localValue.toISOString().slice(0, 16);
}

export function toDateTimeStorageValue(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid follow-up date/time");
  }
  return parsed.toISOString();
}

function formatFollowUpDisplay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const formatted = parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const state = getFollowUpState(parsed.toISOString());
  if (state === "overdue") return `${formatted} · overdue`;
  if (state === "due") return `${formatted} · due now`;
  return formatted;
}

function startOfLocalDay(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function serializeFieldValue(field: MomentumFieldKey, value: string): string | null {
  if (!value) return null;
  return field === "nextTouchAt" ? toDateTimeStorageValue(value) : value;
}
