import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";

const STORAGE_PREFIX = "bridge-settings-unsaved:";

function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, text: string | null): void {
  try {
    if (text === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, text);
  } catch {}
}

/**
 * Free text that is saved on request rather than as it is typed: identity, instructions, paths.
 * Save and Cancel appear once the text differs from the saved value. Unsaved text is kept for this
 * tab in sessionStorage until the server has accepted it, so leaving Settings, reloading or a
 * failed save does not lose it, and closing the tab asks first.
 */
export function DraftTextField({
  storageKey,
  label,
  hideLabel = false,
  help,
  value,
  onCommit,
  multiline = false,
  rows = 3,
  placeholder,
  maxLength,
  error,
  pending = false,
  footer,
}: {
  /** Stable name for this field's unsaved text, unique within Settings. */
  storageKey: string;
  label: string;
  hideLabel?: boolean;
  help?: React.ReactNode;
  value: string;
  onCommit: (text: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  /** A failed save of this field, shown beside it. */
  error?: string | null;
  /** The writer has not finished saving this field's setting. */
  pending?: boolean;
  /** Something that sits at the end of the help line, such as a character count. */
  footer?: (text: string) => React.ReactNode;
}) {
  const id = useId();
  const storageId = `${STORAGE_PREFIX}${storageKey}`;
  const [text, setText] = useState(() => readStored(storageId) ?? value);
  const [restored, setRestored] = useState(() => {
    const stored = readStored(storageId);
    return stored !== null && stored !== value;
  });
  /** Text sent with Save that the server has not answered yet, and the saved value it replaced. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [replaced, setReplaced] = useState(value);
  const textRef = useRef(text);
  textRef.current = text;
  const submittedRef = useRef(submitted);
  submittedRef.current = submitted;
  const savedRef = useRef(value);
  const dirty = text !== value;
  const unsaved = dirty || submitted !== null;

  // A new saved value replaces the text only when the reader has not edited it and no save of
  // theirs is outstanding; a failed save puts the old value back, and the attempt must survive.
  useEffect(() => {
    if (submittedRef.current === null && textRef.current === savedRef.current) setText(value);
    savedRef.current = value;
  }, [value]);

  useEffect(() => {
    // Settled once the writer is done and either failed or shows a new value for this field.
    if (submitted === null || pending || (!error && value === replaced)) return;
    if (!error && textRef.current === submitted) {
      // Accepted and not edited since: show what the server keeps, which may be normalized.
      setText(value);
      setRestored(false);
    }
    setSubmitted(null);
  }, [error, pending, replaced, submitted, value]);

  useEffect(() => {
    // The latest text is what the reader wants kept, even if they kept typing after Save.
    writeStored(storageId, unsaved ? text : null);
  }, [storageId, submitted, text, unsaved]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const save = () => {
    if (!dirty) return;
    setSubmitted(text);
    setReplaced(value);
    onCommit(text);
  };
  const cancel = () => {
    setText(value);
    setRestored(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape" && dirty) {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };

  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help || footer ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value: text,
    placeholder,
    maxLength,
    onChange: (event: { target: { value: string } }) => setText(event.target.value),
    onKeyDown,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className={hideLabel ? "sr-only" : cx(DS.field.label, "block")}>{label}</label>
      {multiline
        ? <textarea {...common} rows={rows} className={cx(DS.field.input, DS.field.textarea, "resize-y")} />
        : <input {...common} className={cx(DS.field.input, DS.field.inputSize.md)} />}
      {(help || footer) && (
        <div id={helpId} className={cx(DS.field.help, "flex flex-wrap justify-between gap-2")}>
          <span>{help}</span>
          {footer?.(text)}
        </div>
      )}
      {error && <p id={errorId} role="alert" className="text-xs text-error">{error}</p>}
      {dirty && !pending && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={save}>Save</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          <span className={DS.field.help}>{restored ? "Unsaved edit restored" : "Not saved yet"}</span>
        </div>
      )}
    </div>
  );
}
