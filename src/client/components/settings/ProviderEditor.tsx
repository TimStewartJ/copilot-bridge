import { useState } from "react";
import { X } from "lucide-react";
import { Field } from "./Field";
import { DS, cx } from "../../design/tokens";

export interface ProviderEditorField {
  key: string;
  label: string;
  placeholder: string;
  required?: boolean;
  validate?: (
    value: string,
    values: Readonly<Record<string, string>>,
  ) => string | null;
}

export interface ProviderEditorProps {
  title: string;
  fields: ProviderEditorField[];
  initialValues?: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
  onClear?: () => void;
  onCancel: () => void;
  isEditing?: boolean;
}

export function ProviderEditor({
  title,
  fields,
  initialValues,
  onSave,
  onClear,
  onCancel,
  isEditing,
}: ProviderEditorProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.key, initialValues?.[f.key] ?? ""]),
    ),
  );

  const trimmedValues = Object.fromEntries(
    fields.map((field) => [field.key, values[field.key]?.trim() ?? ""]),
  );
  const errors: Record<string, string | null> = {};
  for (const f of fields) {
    if (f.required && trimmedValues[f.key] === "") {
      errors[f.key] = `${f.label} is required`;
    } else {
      errors[f.key] = f.validate?.(trimmedValues[f.key] ?? "", trimmedValues) ?? null;
    }
  }
  const canSave = Object.values(errors).every((e) => e === null);

  return (
    <div className={cx(DS.layout.formGroup, DS.choice.selected)}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-accent">
          {isEditing ? `Edit: ${title}` : `Configure ${title}`}
        </div>
        {isEditing && onClear && (
          <button
            onClick={onClear}
            className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "text-[10px] hover:text-error gap-1")}
          >
            <X size={10} />
            Clear
          </button>
        )}
      </div>

      {fields.map((f, i) => (
        <Field key={f.key} label={f.label} error={errors[f.key]}>
          <input
            value={values[f.key] ?? ""}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
            }
            placeholder={f.placeholder}
            className={cx(DS.field.input, DS.field.inputSize.md, DS.focus)}
            autoFocus={i === 0}
          />
        </Field>
      ))}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
        >
          Cancel
        </button>
        <button
          onClick={() => {
            if (!canSave) return;
            const trimmed: Record<string, string> = {};
            for (const f of fields) {
              const v = trimmedValues[f.key] ?? "";
              if (v) trimmed[f.key] = v;
            }
            onSave(trimmed);
          }}
          disabled={!canSave}
          className={cx("px-4 py-1.5 text-xs font-medium rounded-md transition-colors", canSave
              ? cx(DS.button.base, DS.button.size.sm, DS.button.variant.primary)
              : cx(DS.button.base, DS.button.size.sm, "bg-bg-elevated text-text-faint cursor-not-allowed"))}
        >
          {isEditing ? "Update" : "Configure"}
        </button>
      </div>
    </div>
  );
}
