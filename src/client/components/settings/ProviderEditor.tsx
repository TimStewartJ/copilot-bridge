import { useState } from "react";
import { X } from "lucide-react";
import { Field } from "./Field";

export interface ProviderEditorField {
  key: string;
  label: string;
  placeholder: string;
  required?: boolean;
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

  const errors: Record<string, string | null> = {};
  for (const f of fields) {
    if (f.required && (values[f.key]?.trim() ?? "") === "") {
      errors[f.key] = `${f.label} is required`;
    } else {
      errors[f.key] = null;
    }
  }
  const canSave = Object.values(errors).every((e) => e === null);

  return (
    <div className="bg-bg-elevated border border-accent/20 rounded-md p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-accent">
          {isEditing ? `Edit: ${title}` : `Configure ${title}`}
        </div>
        {isEditing && onClear && (
          <button
            onClick={onClear}
            className="text-[10px] text-text-muted hover:text-error transition-colors flex items-center gap-1"
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
            className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
            autoFocus={i === 0}
          />
        </Field>
      ))}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            if (!canSave) return;
            const trimmed: Record<string, string> = {};
            for (const f of fields) {
              const v = values[f.key]?.trim() ?? "";
              if (v) trimmed[f.key] = v;
            }
            onSave(trimmed);
          }}
          disabled={!canSave}
          className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
            canSave
              ? "bg-accent text-white hover:bg-accent-hover"
              : "bg-bg-elevated text-text-faint cursor-not-allowed"
          }`}
        >
          {isEditing ? "Update" : "Configure"}
        </button>
      </div>
    </div>
  );
}
