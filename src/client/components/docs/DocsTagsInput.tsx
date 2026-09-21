import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { normalizeTag, tagsMatch } from "./docs-model";
import { cx } from "./docs-ui";
import { DS } from "../../design/tokens";

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
      className={cx(DS.field.group, disabled && "opacity-60")}
    >
      {tags.map((tag) => (
        <span key={tag} className={cx(DS.tag.base, DS.tag.size.sm, DS.row.selected)}>
          {tag}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
            className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost)}
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
        className={cx(DS.field.inline, "min-w-[7rem]")}
      />
      <datalist id={listId}>
        {available.map((suggestion) => <option key={suggestion} value={suggestion} />)}
      </datalist>
    </div>
  );
}
