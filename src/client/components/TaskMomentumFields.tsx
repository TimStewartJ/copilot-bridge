import { useEffect, useState, type ReactNode } from "react";
import { Pencil, Plus } from "lucide-react";
import type { Task } from "../api";
import { patchTask } from "../api";
import { DS, cx } from "../design/tokens";
import { Button, Field, FieldList, IconButton, Notice, Section, TextInput } from "../design/primitives";
import { formatRevisit, formatRevisitMoment, toDateTimeInputValue, toDateTimeStorageValue } from "../lib/task-revisit";
import { parseWhen, whenToDate } from "../../shared/typed-date";
import TaskDeferralDialog from "./TaskDeferralDialog";

type MomentumFieldKey = "doneWhen" | "nextAction" | "waitingOn" | "nextTouchAt";

type FieldValues = Record<MomentumFieldKey, string>;

interface TaskMomentumFieldsProps {
  task: Task;
  onSaved?: () => void;
  onPatched?: (task: Task) => void;
  /** Rows that belong with the task's status, such as its notes, drawn beneath the fields. */
  children?: ReactNode;
}

interface FieldConfig {
  key: MomentumFieldKey;
  label: string;
  placeholder: string;
  type: "text" | "datetime-local";
  actionLabel: string;
}

const FIELD_CONFIGS: FieldConfig[] = [
  { key: "doneWhen", label: "Done when", placeholder: "What does finished look like?", type: "text", actionLabel: "Set finish line" },
  { key: "nextAction", label: "Next step", placeholder: "What would move this forward?", type: "text", actionLabel: "Add next step" },
  { key: "waitingOn", label: "Waiting for", placeholder: "A reply, delivery, or prerequisite", type: "text", actionLabel: "Add a wait" },
  { key: "nextTouchAt", label: "Revisit on", placeholder: "fri 9am, in 2 weeks, Nov 15", type: "text", actionLabel: "Set revisit date" },
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

export default function TaskMomentumFields(props: TaskMomentumFieldsProps) {
  return <TaskMomentumEditor key={props.task.id} {...props} />;
}

function TaskMomentumEditor({
  task,
  onSaved,
  onPatched,
  children,
}: TaskMomentumFieldsProps) {
  const [values, setValues] = useState<FieldValues>(() => toFieldValues(task));
  const [drafts, setDrafts] = useState<FieldValues>(() => toFieldValues(task));
  const [editingField, setEditingField] = useState<MomentumFieldKey | null>(null);
  const [savingField, setSavingField] = useState<MomentumFieldKey | null>(null);
  const [expandedFields, setExpandedFields] = useState<Set<MomentumFieldKey>>(() => new Set());
  const [deferralOpen, setDeferralOpen] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const next = toFieldValues(task);
    setValues(next);
    setDrafts(next);
    setEditingField(null);
    setSavingField(null);
    setExpandedFields(new Set());
    setSaveError("");
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
    setSaveError("");
    try {
      patchValue = serializeFieldValue(field, normalized);
    } catch (error) {
      console.error(`Failed to validate ${field}`, error);
      setSaveError(error instanceof Error ? error.message : String(error));
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
      setSaveError(error instanceof Error ? error.message : String(error));
      setValues(previousValues);
      setDrafts({ ...previousValues, [field]: normalized });
      setEditingField(field);
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
    // Deferring lives in the task menu; resuming stays here because a deferred task needs it.
    <><Section label="Status" surface action={task.status === "active" && task.deferred ? <Button size="sm" variant="ghost"
      className="-mr-2" disabled={!!savingField} onClick={() => setDeferralOpen(true)}>Resume task</Button> : undefined}>
      {saveError && <Notice tone="danger" title="The change was not saved">{saveError}</Notice>}
      {visiblePanelFields.length > 0 && (
        <FieldList className="-mt-1">
          {visiblePanelFields.map((field) => {
            const currentValue = values[field.key];
            const isEditing = editingField === field.key;
            const isSaving = savingField === field.key;
            const displayValue = formatFieldDisplay(field.key, currentValue);
            const isExpanded = expandedFields.has(field.key);
            const isExpandable = isExpandablePanelValue(displayValue);

            return (
              <Field
                key={field.key}
                stacked
                label={field.label}
                action={isSaving ? (
                  <span className={DS.text.meta} role="status">Saving…</span>
                ) : isEditing ? (
                  currentValue ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="-my-1.5 -mr-2.5"
                      data-clear-field={field.key}
                      // Keeps focus in the field, so its blur does not save the draft first.
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => clearField(field.key)}
                      aria-label={`Clear ${field.label}`}
                    >
                      Clear
                    </Button>
                  ) : undefined
                ) : (
                  <IconButton label={`Edit ${field.label}`} className="-my-2 -mr-2" onClick={() => startEditingField(field.key)}>
                    <Pencil size={13} aria-hidden="true" />
                  </IconButton>
                )}
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
                    onBlur={(event) => {
                      // Tabbing to this field's Clear keeps the edit open so Clear can be pressed.
                      if ((event.relatedTarget as HTMLElement | null)?.dataset?.clearField === field.key) return;
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
                    aria-describedby={field.key === "nextTouchAt" ? `revisit-help-${task.id}` : undefined}
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
                {field.key === "nextTouchAt" && isEditing && drafts.nextTouchAt.trim() && <p className={cx(DS.text.meta, "mt-1.5")}>
                  {readRevisit(drafts.nextTouchAt) ? formatRevisitMoment(toDateTimeStorageValue(readRevisit(drafts.nextTouchAt))) : "Not a date yet"}
                </p>}
                {field.key === "nextTouchAt" && isEditing && <p id={`revisit-help-${task.id}`} className={cx(DS.text.meta, "mt-2")}>Shows under Needs you when it arrives. Nothing starts by itself.</p>}
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
              aria-label={field.actionLabel}
              onClick={() => startEditingField(field.key)}
            >
              {field.label}
            </Button>
          ))}
        </div>
      )}
      {children && <div className={cx(DS.surface.divided, "mt-1 border-t border-surface-edge pt-1")}>{children}</div>}
    </Section>{deferralOpen && <TaskDeferralDialog task={task} onClose={() => setDeferralOpen(false)} onSaved={updated => { onPatched?.(updated); onSaved?.(); }} />}</>
  );
}

function toFieldValues(task: Task): FieldValues {
  return {
    doneWhen: task.doneWhen ?? "",
    nextAction: task.nextAction ?? "",
    waitingOn: task.waitingOn ?? "",
    nextTouchAt: toDateTimeInputValue(task.nextTouchAt),
  };
}

/** A typed revisit ("fri", "in 2 weeks 3pm") as a date-time field value; 9:00 if no time given. */
function readRevisit(value: string): string {
  const when = parseWhen(value.trim());
  return when ? toDateTimeInputValue(whenToDate(when, 9).toISOString()) : "";
}

function normalizeDraft(field: MomentumFieldKey, value: string): string {
  if (field !== "nextTouchAt") return value.trim();
  if (!value.trim()) return "";
  return readRevisit(value) || value.trim();
}

function formatFieldDisplay(field: MomentumFieldKey, value: string): string {
  if (!value) return FIELD_CONFIG_BY_KEY[field].placeholder;
  return field === "nextTouchAt" ? formatRevisit(value) : value;
}

function serializeFieldValue(field: MomentumFieldKey, value: string): string | null {
  if (!value) return null;
  if (field !== "nextTouchAt") return value;
  // Only a value the date reader understood: the browser's own parser rolls Feb 30 into March.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !readRevisit(value)) throw new Error("Couldn't read that date. Try “fri 9am” or “Nov 15”.");
  return toDateTimeStorageValue(value);
}
