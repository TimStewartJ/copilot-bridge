import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { normalizeTag, tagsMatch } from "./docs-model";
import { cx } from "./docs-ui";

export interface DocsTagsInputProps {
  id?: string;
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

/** Chip-style tag editor. Enter or a comma commits a tag; Backspace on an empty box removes one. */
export default function DocsTagsInput({ id, tags, suggestions, onChange, disabled }: DocsTagsInputProps) {
  const listId = useId();
  const [text, setText] = useState("");
  const available = suggestions.filter((suggestion) => !tags.some((tag) => tagsMatch(tag, suggestion)));

  const commit = (raw: string) => {
    const typed = normalizeTag(raw);
    setText("");
    if (!typed || tags.some((tag) => tagsMatch(tag, typed))) return;
    // Reuse the established spelling of a tag that already exists.
    onChange([...tags, suggestions.find((suggestion) => tagsMatch(suggestion, typed)) ?? typed]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      if (!text.trim()) {
        if (event.key === ",") event.preventDefault();
        return;
      }
      event.preventDefault();
      commit(text);
    } else if (event.key === "Backspace" && !text && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div
      className={cx(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg-primary px-2 py-1.5 transition-colors",
        "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 hover:border-text-faint/60",
        disabled && "opacity-60",
      )}
    >
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-bg-surface py-0.5 pl-2 pr-1 text-xs font-medium text-text-secondary">
          {tag}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
            className="rounded-full p-0.5 text-text-faint transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        list={listId}
        disabled={disabled}
        placeholder={tags.length === 0 ? "Add tags…" : ""}
        onChange={(event) => {
          const next = event.target.value;
          // Choosing from the suggestion list replaces the text in one step; typing does not.
          const inputType = (event.nativeEvent as InputEvent).inputType;
          const pickedSuggestion = inputType === "insertReplacementText" || inputType === undefined;
          if (pickedSuggestion && available.some((suggestion) => suggestion === next)) commit(next);
          else setText(next);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => text.trim() && commit(text)}
        className="h-6 min-w-[7rem] flex-1 border-0 bg-transparent px-1 text-sm text-text-primary placeholder:text-text-faint focus:outline-none"
      />
      <datalist id={listId}>
        {available.map((suggestion) => <option key={suggestion} value={suggestion} />)}
      </datalist>
    </div>
  );
}
