import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { isRecord } from "../../../shared/is-record.js";

type JsonContainer = unknown[] | Record<string, unknown>;

const PREVIEW_ENTRIES = 3;
const PREVIEW_STRING_CHARS = 16;
export const JSON_TREE_LONG_STRING_CHARS = 200;

const ROW_CLASS = "flex min-w-0 items-baseline gap-1 rounded px-1.5";

function isContainer(value: unknown): value is JsonContainer {
  return Array.isArray(value) || isRecord(value);
}

function entriesOf(value: JsonContainer): Array<[string, unknown]> {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
}

/** Cuts text to `max` UTF-16 units without splitting a surrogate pair. */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function previewValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (isRecord(value)) return "{…}";
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ");
    return compact.length > PREVIEW_STRING_CHARS
      ? `"${truncateText(compact, PREVIEW_STRING_CHARS)}…"`
      : `"${compact}"`;
  }
  return String(value);
}

function previewContainer(value: JsonContainer): string {
  const entries = entriesOf(value);
  const parts = entries
    .slice(0, PREVIEW_ENTRIES)
    .map(([key, item]) => (Array.isArray(value) ? previewValue(item) : `${key}: ${previewValue(item)}`));
  if (entries.length > PREVIEW_ENTRIES) parts.push("…");
  return Array.isArray(value) ? `[${parts.join(", ")}]` : `{ ${parts.join(", ")} }`;
}

function sizeLabel(value: JsonContainer): string {
  return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
}

function JsonKey({ name, isIndex }: { name: string; isIndex: boolean }) {
  return (
    <span className={`whitespace-nowrap ${isIndex ? "text-text-faint" : "text-agent"}`}>
      {name}
      <span className="text-text-faint">:</span>
    </span>
  );
}

function JsonString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = value.length > JSON_TREE_LONG_STRING_CHARS;
  const shown = isLong && !expanded ? `${truncateText(value, JSON_TREE_LONG_STRING_CHARS)}…` : value;
  return (
    <span className="min-w-0 whitespace-pre-wrap text-syntax-string [overflow-wrap:anywhere]">
      "{shown}"
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="ml-1.5 rounded px-1 font-sans text-[10.5px] text-accent hover:bg-accent-surface"
        >
          {expanded
            ? "Show less"
            : `+${new Intl.NumberFormat().format(value.length - JSON_TREE_LONG_STRING_CHARS)} chars`}
        </button>
      )}
    </span>
  );
}

function JsonScalar({ value }: { value: unknown }) {
  if (value === null) return <span className="italic text-text-faint">null</span>;
  if (typeof value === "string") return <JsonString value={value} />;
  if (typeof value === "number") return <span className="text-accent">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-warning">{String(value)}</span>;
  return <span className="text-text-muted">{String(value)}</span>;
}

function JsonTreeEntry({
  name,
  isIndex,
  value,
  depth,
  defaultExpandDepth,
}: {
  name: string;
  isIndex: boolean;
  value: unknown;
  depth: number;
  defaultExpandDepth: number;
}) {
  const [open, setOpen] = useState(depth < defaultExpandDepth);

  if (!isContainer(value) || entriesOf(value).length === 0) {
    return (
      <div className={`${ROW_CLASS} pl-5 hover:bg-bg-secondary`}>
        <JsonKey name={name} isIndex={isIndex} />
        {isContainer(value)
          ? <span className="text-text-faint">{Array.isArray(value) ? "[]" : "{}"}</span>
          : <JsonScalar value={value} />}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`${ROW_CLASS} w-full text-left hover:bg-bg-secondary`}
      >
        <ChevronRight
          size={10}
          aria-hidden="true"
          className={`shrink-0 self-center text-text-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
        <JsonKey name={name} isIndex={isIndex} />
        <span className="shrink-0 text-text-faint">{sizeLabel(value)}</span>
        {!open && <span className="min-w-0 truncate text-text-muted">{previewContainer(value)}</span>}
      </button>
      {open && (
        <div className="ml-[11px] border-l border-border-subtle pl-2">
          {entriesOf(value).map(([key, item]) => (
            <JsonTreeEntry
              key={key}
              name={key}
              isIndex={Array.isArray(value)}
              value={item}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface JsonTreeProps {
  value: unknown;
  /** Containers nested shallower than this start expanded. */
  defaultExpandDepth?: number;
  className?: string;
}

/** Collapsible, syntax-colored view of parsed JSON. */
export default function JsonTree({ value, defaultExpandDepth = 1, className = "" }: JsonTreeProps) {
  const baseClass = `font-mono text-[11.5px] leading-[1.7] ${className}`;
  if (!isContainer(value)) {
    return (
      <div className={`${baseClass} px-1.5`}>
        <JsonScalar value={value} />
      </div>
    );
  }
  const entries = entriesOf(value);
  return (
    <div className={baseClass}>
      {entries.length === 0 ? (
        <div className="px-1.5 italic text-text-faint">{Array.isArray(value) ? "Empty list" : "Empty object"}</div>
      ) : (
        entries.map(([key, item]) => (
          <JsonTreeEntry
            key={key}
            name={key}
            isIndex={Array.isArray(value)}
            value={item}
            depth={0}
            defaultExpandDepth={defaultExpandDepth}
          />
        ))
      )}
    </div>
  );
}
