import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { SearchKind, SearchScope } from "../../shared/search.js";
import { DS, cx } from "../design/tokens";

export interface SearchScopeOption {
  id: string;
  title: string;
}

export interface SearchFilterChange {
  kind?: string | null;
  scope?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
}

interface Props {
  draft: string;
  kind: SearchKind;
  scope: SearchScope;
  taskId?: string;
  sessionId?: string;
  tasks: SearchScopeOption[];
  sessions: SearchScopeOption[];
  onChange: (value: string) => void;
  onCommit: (query: string, filters: SearchFilterChange) => void;
  showTypeChip?: boolean;
}

interface Suggestion {
  label: string;
  filters: SearchFilterChange;
}

// A quoted phrase is literal text, even when it contains filter-like syntax.
export function getSearchFilterToken(value: string) {
  const tokens = [...value.matchAll(/"[^"]*"|(?:type|task|chat):(?:"[^"]*"|[^"]*)$/gi)];
  const token = tokens.at(-1);
  if (!token || token.index === undefined || (token.index > 0 && !/\s/.test(value[token.index - 1]))) return null;
  const match = /^(type|task|chat):(.*)$/i.exec(token[0]);
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: match[2].trim().replace(/^"|"$/g, ""), start: token.index };
}

export function extractSearchTypeFilters(value: string): { query: string; kind: string } | null {
  let kind: string | undefined;
  const query = value.replace(/"[^"]*"|(?:^|\s)type:(chat|task|doc)(?=\s)/gi, (match, type: string | undefined) => {
    if (!type) return match;
    kind = type.toLowerCase();
    return " ";
  });
  return kind ? { query: query.trim(), kind } : null;
}

export default function SearchQueryInput({ draft, kind, scope, taskId, sessionId, tasks, sessions, onChange, onCommit, showTypeChip = true }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [composing, setComposing] = useState(false);
  const token = getSearchFilterToken(draft);
  const options: Suggestion[] = token?.key === "type"
    ? ["chat", "task", "doc"].filter((value) => value.startsWith(token.value.toLowerCase())).map((value) => ({
        label: `type:${value}`, filters: { kind: value },
      }))
    : token ? (token.key === "task" ? tasks : sessions)
      .filter((option) => option.title.toLocaleLowerCase().includes(token.value.toLocaleLowerCase()) || option.id === token.value)
      .slice(0, 20)
      .map((option) => ({
        label: `${token.key}:${option.title}`,
        filters: { scope: token.key === "task" ? "task" : "session", taskId: token.key === "task" ? option.id : null, sessionId: token.key === "chat" ? option.id : null },
      })) : [];
  const expanded = token !== null && !dismissed && !composing;
  const activeIndex = Math.min(selected, Math.max(0, options.length - 1));
  useEffect(() => {
    if (expanded) activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, expanded, draft]);
  const commit = (option: Suggestion) => {
    onCommit(draft.slice(0, token?.start ?? draft.length).trim(), option.filters);
    setSelected(0);
    setDismissed(false);
    inputRef.current?.focus();
  };
  const scopeTitle = scope === "task"
    ? tasks.find((task) => task.id === taskId)?.title ?? taskId ?? "Unavailable task"
    : sessions.find((session) => session.id === sessionId)?.title ?? sessionId ?? "Unavailable chat";
  const remove = (filters: SearchFilterChange) => {
    onCommit(draft, filters);
    inputRef.current?.focus();
  };
  return <div className="relative">
    <div className={DS.field.group}>
      <Search size={17} className="shrink-0 text-text-muted" />
      {scope !== "global" && <button type="button" aria-label="Remove scope" title={scopeTitle}
        onClick={() => remove({ scope: null, taskId: null, sessionId: null })}
        className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "max-w-full gap-1")}>
        <span className="truncate">{scope === "task" ? "task" : "chat"}:{scopeTitle}</span><X size={12} className="shrink-0" />
      </button>}
      {showTypeChip && kind !== "all" && <button type="button" aria-label="Remove type filter" onClick={() => remove({ kind: null })}
        className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "gap-1")}>
        type:{kind}<X size={12} />
      </button>}
      <input ref={inputRef} id="bridge-global-search-input" role="combobox" aria-label="Search chats, tasks, and docs"
        aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && options.length ? `${listId}-${activeIndex}` : undefined}
        value={draft} placeholder="Search chats, tasks, and docs…" autoComplete="off"
        className={cx(DS.field.inline, "min-w-32")}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        onChange={(event) => {
          const value = event.target.value;
          setSelected(0);
          setDismissed(false);
          // A space finishes a source token; incomplete/unknown tokens remain editable.
          const extracted = extractSearchTypeFilters(value);
          if (!composing && extracted) {
            onCommit(extracted.query, { kind: extracted.kind });
          } else onChange(value);
        }}
        onKeyDown={(event) => {
          if (composing || event.nativeEvent?.isComposing) return;
          if (expanded && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(true);
          } else if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setSelected((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length));
          } else if (expanded && event.key === "Enter" && options[activeIndex]) {
            event.preventDefault();
            commit(options[activeIndex]);
          } else if (event.key === "Backspace" && !draft) {
            if (kind !== "all") remove({ kind: null });
            else if (scope !== "global") remove({ scope: null, taskId: null, sessionId: null });
          }
        }}
      />
      {draft && <button type="button" aria-label="Clear search" onClick={() => { onChange(""); inputRef.current?.focus(); }}
        className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost)}><X size={15} /></button>}
    </div>
    {expanded && <div id={listId} role="listbox" aria-label="Search filters"
      className={cx(DS.surface.floating, "absolute inset-x-0 top-full z-10 mt-1 max-h-[min(15rem,35dvh)] overflow-y-auto p-1")}>
      {options.map((option, index) => <div key={`${option.label}-${index}`} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex}
        ref={index === activeIndex ? activeOptionRef : undefined}
        onMouseDown={(event) => event.preventDefault()} onClick={() => commit(option)}
        className={cx(DS.menu.item, "cursor-pointer break-words", index === activeIndex && DS.menu.selected)}>
        {option.label}
      </div>)}
      {!options.length && <div role="status" className="px-3 py-2 text-sm text-text-muted">
        {token?.key === "type" ? "Use type:chat, type:task, or type:doc." : "No matching scope. Edit the name or remove the filter text."}
      </div>}
    </div>}
  </div>;
}
