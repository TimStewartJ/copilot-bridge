import { useEffect, useState } from "react";
import type { Task } from "../api";
import { patchTask } from "../api";

type MomentumFieldKey = "doneWhen" | "nextAction" | "waitingOn" | "nextTouchAt";

type FieldValues = Record<MomentumFieldKey, string>;
export type FollowUpState = "overdue" | "due" | "upcoming" | null;
export type PanelFieldTone = "danger" | "warning" | null;

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
  actionLabel: string;
}

const FIELD_CONFIGS: FieldConfig[] = [
  { key: "doneWhen", label: "Done when", placeholder: "Define the finish line", type: "text", actionLabel: "Set done when" },
  { key: "nextAction", label: "Next action", placeholder: "Capture the next concrete step", type: "text", actionLabel: "Add next action" },
  { key: "waitingOn", label: "Waiting on", placeholder: "Who or what is blocking this", type: "text", actionLabel: "Add blocker" },
  { key: "nextTouchAt", label: "Follow up on", placeholder: "Pick a follow-up date and time", type: "datetime-local", actionLabel: "Set follow-up" },
];

const FIELD_CONFIG_BY_KEY = FIELD_CONFIGS.reduce<Record<MomentumFieldKey, FieldConfig>>((acc, config) => {
  acc[config.key] = config;
  return acc;
}, {
  doneWhen: FIELD_CONFIGS[0],
  nextAction: FIELD_CONFIGS[1],
  waitingOn: FIELD_CONFIGS[2],
  nextTouchAt: FIELD_CONFIGS[3],
});

const PANEL_FIELD_ORDER: MomentumFieldKey[] = ["nextAction", "waitingOn", "nextTouchAt", "doneWhen"];

export function getVisibleMomentumFieldKeys(kind: Task["kind"]): MomentumFieldKey[] {
  return kind === "ongoing"
    ? ["nextAction", "waitingOn", "nextTouchAt"]
    : FIELD_CONFIGS.map((field) => field.key);
}

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
  }, [task.id, task.kind, task.doneWhen, task.nextAction, task.waitingOn, task.nextTouchAt]);

  const isDashboard = variant === "dashboard";
  const visibleFieldKeys = getVisibleMomentumFieldKeys(task.kind);
  const orderedPanelFields = PANEL_FIELD_ORDER
    .filter((key) => visibleFieldKeys.includes(key))
    .map((key) => FIELD_CONFIG_BY_KEY[key]);
  const visiblePanelFields = orderedPanelFields.filter((field) => values[field.key] || editingField === field.key);
  const quickAddFields = orderedPanelFields.filter((field) => !values[field.key] && editingField !== field.key);

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

  if (!isDashboard) {
    return (
      <div className="rounded-md border border-border bg-bg-surface overflow-hidden">
        <div className="px-3 py-2 border-b border-border/70 bg-bg-secondary/40">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Momentum
          </div>
          <div className="text-[11px] text-text-faint mt-0.5">
            {getPanelSummary(values)}
          </div>
        </div>

        {visiblePanelFields.length > 0 ? (
          <div className="divide-y divide-border/70">
            {visiblePanelFields.map((field) => {
              const currentValue = values[field.key];
              const isEditing = editingField === field.key;
              const isSaving = savingField === field.key;
              const tone = getPanelFieldTone(field.key, currentValue);
              const rowClassName = tone === "danger"
                ? "bg-error/10"
                : tone === "warning"
                  ? "bg-warning/10"
                  : "";
              const labelClassName = tone === "danger"
                ? "text-error"
                : tone === "warning"
                  ? "text-warning"
                  : "text-text-muted";

              return (
                <div key={field.key} className={`px-3 py-2 ${rowClassName}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${labelClassName}`}>
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
                      className="mt-1.5 w-full rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
                      placeholder={field.placeholder}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDrafts(values);
                        setEditingField(field.key);
                      }}
                      className="mt-1 w-full text-left text-xs leading-5 text-text-primary transition-colors hover:text-accent"
                      title={currentValue || field.placeholder}
                    >
                      <span className="line-clamp-2">
                        {formatFieldDisplay(field.key, currentValue)}
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}

        {quickAddFields.length > 0 && (
          <div className={`px-3 py-2 flex flex-wrap gap-1.5 ${visiblePanelFields.length > 0 ? "border-t border-border/70" : ""}`}>
            {quickAddFields.map((field) => (
              <button
                key={field.key}
                type="button"
                onClick={() => {
                  setDrafts(values);
                  setEditingField(field.key);
                }}
                className="rounded-full border border-border bg-bg-secondary px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-text-muted/40 hover:text-text-primary"
              >
                {field.actionLabel}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={isDashboard ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : "space-y-2"}>
      {FIELD_CONFIGS.filter((field) => visibleFieldKeys.includes(field.key)).map((field) => {
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

export function getPanelFieldTone(
  field: MomentumFieldKey,
  value: string,
  now = new Date(),
): PanelFieldTone {
  if (field !== "nextTouchAt" || !value) return null;
  const state = getFollowUpState(value, now);
  if (state === "overdue") return "danger";
  if (state === "due") return "warning";
  return null;
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

function formatFieldDisplay(field: MomentumFieldKey, value: string): string {
  if (!value) return FIELD_CONFIG_BY_KEY[field].placeholder;
  return field === "nextTouchAt" ? formatFollowUpDisplay(value) : value;
}

function getPanelSummary(values: FieldValues): string {
  const cues: string[] = [];
  if (values.nextAction) cues.push("next step ready");
  if (values.waitingOn) cues.push("blocker noted");
  if (values.nextTouchAt) cues.push("follow-up set");
  if (values.doneWhen) cues.push("finish line defined");
  return cues.length > 0
    ? cues.slice(0, 2).join(" · ")
    : "Keep the next step, blocker, or follow-up close at hand.";
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
