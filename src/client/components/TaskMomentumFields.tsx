import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Task } from "../api";
import { patchTask } from "../api";
import { DS, cx } from "../design/tokens";
import { Button, Field, FieldList, Section, TextInput } from "../design/primitives";

type MomentumFieldKey = "doneWhen" | "nextAction" | "waitingOn" | "nextTouchAt";

type FieldValues = Record<MomentumFieldKey, string>;
export type FollowUpState = "overdue" | "due" | "upcoming" | null;
export type PanelFieldTone = "danger" | "warning" | null;

interface TaskMomentumFieldsProps {
  task: Task;
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
const PANEL_EXPAND_THRESHOLD = 96;

export function getVisibleMomentumFieldKeys(kind: Task["kind"]): MomentumFieldKey[] {
  return kind === "ongoing"
    ? ["nextAction", "waitingOn", "nextTouchAt"]
    : FIELD_CONFIGS.map((field) => field.key);
}

export function isExpandablePanelValue(value: string): boolean {
  return value.length > PANEL_EXPAND_THRESHOLD || /\r?\n/.test(value);
}

export default function TaskMomentumFields({
  task,
  onSaved,
  onPatched,
}: TaskMomentumFieldsProps) {
  const [values, setValues] = useState<FieldValues>(() => toFieldValues(task));
  const [drafts, setDrafts] = useState<FieldValues>(() => toFieldValues(task));
  const [editingField, setEditingField] = useState<MomentumFieldKey | null>(null);
  const [savingField, setSavingField] = useState<MomentumFieldKey | null>(null);
  const [expandedFields, setExpandedFields] = useState<Set<MomentumFieldKey>>(() => new Set());

  useEffect(() => {
    const next = toFieldValues(task);
    setValues(next);
    setDrafts(next);
    setEditingField(null);
    setSavingField(null);
    setExpandedFields(new Set());
  }, [task.id, task.kind, task.doneWhen, task.nextAction, task.waitingOn, task.nextTouchAt]);

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

  const startEditingField = (field: MomentumFieldKey) => {
    setDrafts(values);
    setEditingField(field);
    setExpandedFields((current) => {
      if (!current.has(field)) return current;
      const next = new Set(current);
      next.delete(field);
      return next;
    });
  };

  const toggleExpandedField = (field: MomentumFieldKey) => {
    setExpandedFields((current) => {
      const next = new Set(current);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  };

  const clearField = (field: MomentumFieldKey) => {
    setExpandedFields((current) => {
      if (!current.has(field)) return current;
      const next = new Set(current);
      next.delete(field);
      return next;
    });
    void persistField(field, "");
  };

  return (
    <Section label="Momentum" surface>
      {visiblePanelFields.length > 0 && (
        <FieldList>
          {visiblePanelFields.map((field) => {
            const currentValue = values[field.key];
            const isEditing = editingField === field.key;
            const isSaving = savingField === field.key;
            const tone = getPanelFieldTone(field.key, currentValue);
            const displayValue = formatFieldDisplay(field.key, currentValue);
            const isExpanded = expandedFields.has(field.key);
            const isExpandable = isExpandablePanelValue(displayValue);

            return (
              <Field
                key={field.key}
                stacked
                label={<span className={tone ? DS.tone[tone] : undefined}>{field.label}</span>}
                action={isSaving ? (
                  <span className={DS.text.meta} role="status">Saving…</span>
                ) : currentValue && !isEditing ? (
                  <div className="-mr-2.5 flex shrink-0 items-center">
                    <Button size="sm" variant="ghost" onClick={() => startEditingField(field.key)} aria-label={`Edit ${field.label}`}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => clearField(field.key)} aria-label={`Clear ${field.label}`}>
                      Clear
                    </Button>
                  </div>
                ) : undefined}
              >
                {isEditing ? (
                  <TextInput
                    autoFocus
                    inputSize="sm"
                    type={field.type}
                    aria-label={`Edit ${field.label}`}
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
                    placeholder={field.placeholder}
                  />
                ) : isExpandable ? (
                  <button
                    type="button"
                    onClick={() => toggleExpandedField(field.key)}
                    className={cx("block w-full rounded text-left text-[13px] leading-5 text-text-primary", DS.focus)}
                    title={currentValue || field.placeholder}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${field.label}`}
                  >
                    <span className={
                      isExpanded
                        ? "block whitespace-pre-wrap break-words"
                        : "block max-h-[3.75rem] overflow-hidden break-words line-clamp-3 md:max-h-10 md:line-clamp-2"
                    }>
                      {displayValue}
                    </span>
                  </button>
                ) : (
                  <div className="break-words leading-5" title={currentValue || field.placeholder}>
                    {displayValue}
                  </div>
                )}
              </Field>
            );
          })}
        </FieldList>
      )}

      {quickAddFields.length > 0 && (
        <div className={cx("-mx-2 flex flex-wrap", visiblePanelFields.length > 0 && "mt-1")}>
          {quickAddFields.map((field) => (
            <Button
              key={field.key}
              size="sm"
              variant="ghost"
              icon={<Plus size={12} aria-hidden="true" />}
              onClick={() => startEditingField(field.key)}
            >
              {field.actionLabel}
            </Button>
          ))}
        </div>
      )}
    </Section>
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

function startOfLocalDay(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function serializeFieldValue(field: MomentumFieldKey, value: string): string | null {
  if (!value) return null;
  return field === "nextTouchAt" ? toDateTimeStorageValue(value) : value;
}
