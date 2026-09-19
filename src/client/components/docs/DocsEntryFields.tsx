import { useId } from "react";
import { Check, ExternalLink, Minus } from "lucide-react";
import type { DbSchema } from "../../api";
import { dbFieldLabel, formatDocDate, visibleDbFields, type DbField, type EntryFormValues } from "./docs-model";
import { cx, DocsField, DocsInput, DocsSelect } from "./docs-ui";

const SELECT_TONES = [
  "bg-blue-500/15 text-blue-400",
  "bg-emerald-500/15 text-emerald-400",
  "bg-amber-500/15 text-amber-400",
  "bg-purple-500/15 text-purple-400",
  "bg-rose-500/15 text-rose-400",
  "bg-cyan-500/15 text-cyan-400",
  "bg-orange-500/15 text-orange-400",
  "bg-indigo-500/15 text-indigo-400",
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** A stable colour per option: by position in the schema, or by hash for stray values. */
function selectTone(value: string, options?: string[]): string {
  const position = options?.indexOf(value) ?? -1;
  return SELECT_TONES[(position >= 0 ? position : hashString(value)) % SELECT_TONES.length];
}

function shortUrl(value: string): string {
  return value.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

/** Read-only rendering of one field value, shared by the table, the cards and the entry page. */
export function DbValue({ field, value, wrap = false }: { field: DbField; value: unknown; wrap?: boolean }) {
  if (value == null || value === "") return <span className="text-text-faint">—</span>;

  switch (field.type) {
    case "select": {
      const text = String(value);
      return (
        <span className={cx("inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium", selectTone(text, field.options))}>
          <span className="truncate">{text}</span>
        </span>
      );
    }
    case "boolean":
      return value === true || value === "true"
        ? <Check size={15} className="text-success" aria-label="Yes" />
        : <Minus size={15} className="text-text-faint" aria-label="No" />;
    case "date":
      return <span className="whitespace-nowrap tabular-nums">{formatDocDate(String(value))}</span>;
    case "number":
      return <span className="tabular-nums">{String(value)}</span>;
    case "url": {
      const href = String(value);
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex max-w-full items-center gap-1 text-accent hover:underline"
        >
          <span className="truncate">{shortUrl(href)}</span>
          <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
        </a>
      );
    }
    default:
      return <span className={wrap ? "whitespace-pre-wrap break-words" : undefined}>{String(value)}</span>;
  }
}

export interface EntryFieldsFormProps {
  schema: DbSchema;
  values: EntryFormValues;
  errors: Record<string, string>;
  onChange: (name: string, value: string | boolean) => void;
  disabled?: boolean;
  columns?: 1 | 2;
}

/** Inputs for a collection's schema fields, one control per field type. */
export function EntryFieldsForm({ schema, values, errors, onChange, disabled, columns = 2 }: EntryFieldsFormProps) {
  const baseId = useId();
  const fields = visibleDbFields(schema);
  if (fields.length === 0) return null;

  return (
    <div className={cx("grid gap-x-4 gap-y-4", columns === 2 && "sm:grid-cols-2")}>
      {fields.map((field) => {
        const id = `${baseId}-${field.name}`;
        const label = dbFieldLabel(field.name);
        const error = errors[field.name];
        const value = values[field.name];

        if (field.type === "boolean") {
          return (
            <label key={field.name} htmlFor={id} className="flex h-9 cursor-pointer items-center gap-2.5 self-end text-sm text-text-primary">
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                disabled={disabled}
                onChange={(event) => onChange(field.name, event.target.checked)}
                className="h-4 w-4 rounded border-border accent-accent"
              />
              {label}
            </label>
          );
        }

        const text = typeof value === "string" ? value : "";
        return (
          <DocsField key={field.name} label={label} htmlFor={id} required={field.required} error={error}>
            {field.type === "select" ? (
              <DocsSelect id={id} value={text} disabled={disabled} invalid={Boolean(error)} onChange={(event) => onChange(field.name, event.target.value)}>
                <option value="">{field.required ? "Choose…" : "None"}</option>
                {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                {text && !(field.options ?? []).includes(text) && <option value={text}>{text}</option>}
              </DocsSelect>
            ) : (
              <DocsInput
                id={id}
                type={field.type === "date" ? "date" : field.type === "url" ? "url" : "text"}
                inputMode={field.type === "number" ? "decimal" : undefined}
                placeholder={field.type === "url" ? "https://" : undefined}
                value={text}
                disabled={disabled}
                invalid={Boolean(error)}
                onChange={(event) => onChange(field.name, event.target.value)}
              />
            )}
          </DocsField>
        );
      })}
    </div>
  );
}
