import { useCallback, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  Bold,
  Brackets,
  Code,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  SquareCode,
  Table,
  TextQuote,
  type LucideIcon,
} from "lucide-react";
import {
  applyMarkdownAction,
  computeTextChange,
  continueListOnEnter,
  indentListOnTab,
  type MarkdownAction,
  type TextEdit,
} from "./docs-markdown-edit";
import { cx } from "./docs-ui";

interface ToolbarItem {
  action: MarkdownAction;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
}

const TOOLBAR_GROUPS: ToolbarItem[][] = [
  [
    { action: "bold", label: "Bold", icon: Bold, shortcut: "B" },
    { action: "italic", label: "Italic", icon: Italic, shortcut: "I" },
    { action: "code", label: "Inline code", icon: Code },
    { action: "link", label: "Link", icon: Link2 },
    { action: "wikilink", label: "Link to a docs page", icon: Brackets },
  ],
  [
    { action: "heading2", label: "Heading", icon: Heading2 },
    { action: "heading3", label: "Subheading", icon: Heading3 },
  ],
  [
    { action: "bulletList", label: "Bulleted list", icon: List },
    { action: "numberedList", label: "Numbered list", icon: ListOrdered },
    { action: "taskList", label: "Task list", icon: ListChecks },
    { action: "quote", label: "Quote", icon: TextQuote },
  ],
  [
    { action: "codeBlock", label: "Code block", icon: SquareCode },
    { action: "table", label: "Table", icon: Table },
    { action: "divider", label: "Divider", icon: Minus },
  ],
];

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgent);

/**
 * Applies an edit through the browser's own editing commands so Ctrl+Z steps back through
 * toolbar actions exactly like typed text. Falls back to a direct write where that is missing.
 */
function commitEdit(textarea: HTMLTextAreaElement, next: TextEdit, onChange: (value: string) => void): void {
  const change = computeTextChange(textarea.value, next.value);
  if (change.start !== change.end || change.insert) {
    textarea.focus();
    textarea.setSelectionRange(change.start, change.end);
    let applied = false;
    try {
      applied = change.insert
        ? document.execCommand("insertText", false, change.insert)
        : document.execCommand("delete");
    } catch {
      applied = false;
    }
    if (!applied || textarea.value !== next.value) {
      textarea.value = next.value;
      onChange(next.value);
    }
  }
  textarea.setSelectionRange(next.selectionStart, next.selectionEnd);
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Extra controls rendered at the right edge of the toolbar, such as the preview toggle. */
  toolbarEnd?: ReactNode;
  /** Grows with its content instead of scrolling internally. */
  minHeightClassName?: string;
}

export default function MarkdownEditor({
  value,
  onChange,
  onSave,
  textareaRef,
  id,
  placeholder = "Write in Markdown…",
  disabled = false,
  toolbarEnd,
  minHeightClassName = "min-h-[50vh]",
}: MarkdownEditorProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? localRef;

  const currentState = (textarea: HTMLTextAreaElement): TextEdit => ({
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  });

  const runAction = useCallback((action: MarkdownAction) => {
    const textarea = ref.current;
    if (!textarea || disabled) return;
    commitEdit(textarea, applyMarkdownAction(currentState(textarea), action), onChange);
  }, [disabled, onChange, ref]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    const modifier = IS_MAC ? event.metaKey : event.ctrlKey;

    if (modifier && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === "s" && onSave) {
        event.preventDefault();
        onSave();
        return;
      }
      if (key === "b" || key === "i") {
        event.preventDefault();
        runAction(key === "b" ? "bold" : "italic");
        return;
      }
    }

    if (event.nativeEvent.isComposing || modifier || event.altKey) return;

    if (event.key === "Enter" && !event.shiftKey) {
      const next = continueListOnEnter(currentState(textarea));
      if (next) {
        event.preventDefault();
        commitEdit(textarea, next, onChange);
      }
    } else if (event.key === "Tab") {
      const next = indentListOnTab(currentState(textarea), event.shiftKey);
      if (next) {
        event.preventDefault();
        commitEdit(textarea, next, onChange);
      }
    }
  };

  const sharedText = "docs-editor-textarea col-start-1 row-start-1 w-full whitespace-pre-wrap break-words px-4 py-4 sm:px-5";

  return (
    <div className="flex min-w-0 flex-col">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="sticky top-0 z-10 flex items-center gap-1 overflow-x-auto border-b border-border bg-bg-primary/95 px-2 py-1.5 backdrop-blur docs-no-scrollbar"
      >
        {TOOLBAR_GROUPS.map((group, groupIndex) => (
          <div key={groupIndex} className="flex shrink-0 items-center gap-0.5">
            {groupIndex > 0 && <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />}
            {group.map(({ action, label, icon: Icon, shortcut }) => (
              <button
                key={action}
                type="button"
                disabled={disabled}
                aria-label={label}
                title={shortcut ? `${label} (${IS_MAC ? "⌘" : "Ctrl+"}${shortcut})` : label}
                // Keep the textarea's selection: a toolbar press must not blur it first.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runAction(action)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-40"
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
        ))}
        {toolbarEnd && <div className="ml-auto flex shrink-0 items-center pl-2">{toolbarEnd}</div>}
      </div>

      {/* The hidden replica sizes the grid cell, so the textarea grows with its text and the
          page scrolls as one document, with no measuring and no scroll jumps while typing. */}
      <div className={cx("grid min-w-0", minHeightClassName)}>
        <div aria-hidden="true" className={cx(sharedText, "invisible")}>{`${value}\n`}</div>
        <textarea
          ref={ref}
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className={cx(
            sharedText,
            "resize-none overflow-hidden border-0 bg-transparent text-text-primary placeholder:text-text-faint focus:outline-none",
          )}
        />
      </div>
    </div>
  );
}
