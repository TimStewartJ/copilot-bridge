import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Task } from "../api";
import { patchTask } from "../api";
import { DS, cx } from "../design/tokens";
import { Button, DisclosureRow, Field, FieldList, Notice, Section, TextInput } from "../design/primitives";
import { formatRevisit, toDateTimeInputValue, toDateTimeStorageValue } from "../lib/task-revisit";
import { getTaskLifecycleDisplayState, getTaskStatusLabel } from "../task-completion-helpers";
import TaskDeferralDialog from "./TaskDeferralDialog";

type MomentumFieldKey = "doneWhen" | "nextAction" | "waitingOn" | "nextTouchAt";

type FieldValues = Record<MomentumFieldKey, string>;

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
  { key: "doneWhen", label: "Done when", placeholder: "What does finished look like?", type: "text", actionLabel: "Set finish line" },
  { key: "nextAction", label: "Next step", placeholder: "What would move this forward?", type: "text", actionLabel: "Add next step" },
  { key: "waitingOn", label: "Waiting for", placeholder: "A reply, delivery, or prerequisite", type: "text", actionLabel: "Add a wait" },
  { key: "nextTouchAt", label: "Revisit on", placeholder: "When would you like to check back?", type: "datetime-local", actionLabel: "Set revisit date" },
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

export function getTaskContextSummary(task: Task): string {
  if (getTaskLifecycleDisplayState(task) !== "active") return getTaskStatusLabel(task);
  const revisit = task.nextTouchAt ? `Revisit ${new Date(task.nextTouchAt).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  })}` : undefined;
  if (task.deferred) return revisit ? `Deferred · ${revisit}` : "Deferred";
  if (task.nextAction?.trim()) return `Next: ${task.nextAction.trim().replace(/\s+/g, " ")}`;
  if (task.waitingOn?.trim()) return `Waiting for: ${task.waitingOn.trim().replace(/\s+/g, " ")}`;
  if (revisit) return revisit;
  if (task.kind !== "ongoing" && task.doneWhen?.trim()) return `Done when: ${task.doneWhen.trim().replace(/\s+/g, " ")}`;
  return "No next step set";
}

export default function TaskMomentumFields(props: TaskMomentumFieldsProps) {
  return <TaskMomentumEditor key={props.task.id} {...props} />;
}

function TaskMomentumEditor({
  task,
  onSaved,
  onPatched,
}: TaskMomentumFieldsProps) {
  const [values, setValues] = useState<FieldValues>(() => toFieldValues(task));
  const [drafts, setDrafts] = useState<FieldValues>(() => toFieldValues(task));
  const [editingField, setEditingField] = useState<MomentumFieldKey | null>(null);
  const [savingField, setSavingField] = useState<MomentumFieldKey | null>(null);
  const [expandedFields, setExpandedFields] = useState<Set<MomentumFieldKey>>(() => new Set());
  const [deferralOpen, setDeferralOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const summary = getTaskContextSummary({ ...task, ...values, nextTouchAt: task.nextTouchAt });

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
    <><Section label="Where things stand" surface action={task.status === "active" ? <Button size="sm" variant="ghost"
      disabled={!!savingField} onClick={() => setDeferralOpen(true)}>{task.deferred ? "Resume task" : "Defer task"}</Button> : undefined}>
      {saveError && <Notice tone="danger" title="The change was not saved">{saveError}</Notice>}
      <DisclosureRow
        label={<span className={cx(DS.row.touch, "flex items-center")}><span className="truncate">{summary}</span></span>}
        title={summary}
        expanded={expanded}
        onToggle={setExpanded}
      >
      {visiblePanelFields.length > 0 && (
        <FieldList>
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
      {editingField === "waitingOn" && <p className={cx(DS.text.meta, "mt-2")}>A wait need not block other work.</p>}
      {editingField === "nextTouchAt" && <p id={`revisit-help-${task.id}`} className={cx(DS.text.meta, "mt-2")}>Shows on Home when due, unless muted. No notification or automatic start.</p>}
      </DisclosureRow>
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

function normalizeDraft(field: MomentumFieldKey, value: string): string {
  return field === "nextTouchAt" ? value : value.trim();
}

function formatFieldDisplay(field: MomentumFieldKey, value: string): string {
  if (!value) return FIELD_CONFIG_BY_KEY[field].placeholder;
  return field === "nextTouchAt" ? formatRevisit(value) : value;
}

function serializeFieldValue(field: MomentumFieldKey, value: string): string | null {
  if (!value) return null;
  return field === "nextTouchAt" ? toDateTimeStorageValue(value) : value;
}
