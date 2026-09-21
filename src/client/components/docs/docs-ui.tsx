/**
 * Small presentational primitives shared across the Docs view, so every button, field and
 * dialog in it looks and behaves the same.
 */
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { AlertTriangle, Info, Loader2, X, type LucideIcon } from "lucide-react";
import { Button, IconButton, Notice, Select, TextArea, TextInput } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import { useModalDialog } from "../shared/useModalDialog";

export { cx } from "../../design/tokens";

/** Live width of an element, for layout decisions that depend on the pane rather than the window. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  // Measured before the first paint: a layout that depends on this must not visibly reflow.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// ── Buttons ───────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export interface DocsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  loading?: boolean;
}

export const DocsButton = forwardRef<HTMLButtonElement, DocsButtonProps>(function DocsButton(
  { variant = "secondary", size = "sm", icon: Icon, loading = false, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <Button
      {...rest}
      ref={ref}
      type={type}
      variant={variant}
      size={size}
      disabled={disabled || loading}
      icon={loading ? <Loader2 size={14} className="animate-spin" /> : Icon ? <Icon size={14} /> : undefined}
      className={className}
    >
      {children}
    </Button>
  );
});

export interface DocsIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  size?: number;
}

export const DocsIconButton = forwardRef<HTMLButtonElement, DocsIconButtonProps>(function DocsIconButton(
  { icon: Icon, label, active = false, size = 16, className, type = "button", ...rest },
  ref,
) {
  return (
    <IconButton
      {...rest}
      ref={ref}
      type={type}
      label={label}
      className={cx(active && DS.row.selected, className)}
    >
      <Icon size={size} />
    </IconButton>
  );
});

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-bg-surface px-1 font-sans text-[10px] font-medium text-text-muted">
      {children}
    </kbd>
  );
}

// ── Form fields ───────────────────────────────────────────────────

export const DocsInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function DocsInput({ className, invalid, ...rest }, ref) {
    return <TextInput {...rest} ref={ref} aria-invalid={invalid || undefined} className={cx(invalid && "border-error/70", className)} />;
  },
);

export const DocsSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function DocsSelect({ className, invalid, children, ...rest }, ref) {
    return (
      <Select {...rest} ref={ref} aria-invalid={invalid || undefined} className={cx("pr-8", invalid && "border-error/70", className)}>
        {children}
      </Select>
    );
  },
);

export const DocsTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function DocsTextarea({ className, invalid, ...rest }, ref) {
    return <TextArea {...rest} ref={ref} aria-invalid={invalid || undefined} className={cx(invalid && "border-error/70", className)} />;
  },
);

export function DocsField({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-center gap-1 text-[13px] font-medium text-text-secondary">
        {label}
        {required && <span className="text-error" aria-hidden="true">*</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-error">{error}</p>
      ) : hint ? (
        <p className="text-xs text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function DocsBanner({
  tone,
  children,
  actions,
}: {
  tone: "error" | "warning" | "info";
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Notice
      tone={tone === "error" ? "danger" : tone}
      icon={tone === "info" ? <Info size={15} /> : <AlertTriangle size={15} />}
      role={tone === "error" ? "alert" : "status"}
      action={actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      className="flex-wrap text-[13px]"
    >
      {children}
    </Notice>
  );
}

// ── Dialog ────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function findFocusable(root: HTMLElement | null, selector = FOCUSABLE_SELECTOR): HTMLElement[] {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

export interface DocsDialogProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Keeps the dialog open while work is in flight. */
  busy?: boolean;
  size?: "sm" | "md" | "lg";
  /** Fills the height available, for dialogs whose body is a long scrolling list. */
  tall?: boolean;
}

const DIALOG_WIDTHS = { sm: "md:max-w-md", md: "md:max-w-lg", lg: "md:max-w-2xl" } as const;

/** A centered dialog on desktop and a bottom sheet on phones, with focus kept inside it. */
export function DocsDialog({ title, description, onClose, children, footer, busy = false, size = "md", tall = false }: DocsDialogProps) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose, dismissible: !busy });
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const initial = findFocusable(panel, "[data-autofocus]")[0] ?? findFocusable(panel)[0];
    initial?.focus();
    return () => previous?.focus();
  }, []);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = findFocusable(panelRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="docs-ui fixed inset-0 z-50 flex items-end justify-center md:items-start md:px-4 md:pt-[12vh]">
      <div className="docs-fade-in absolute inset-0 bg-black/60" onClick={busy ? undefined : onClose} />
      <div
        {...dialogProps}
        ref={panelRef}
        onKeyDown={trapFocus}
        className={cx(DS.surface.dialog, "docs-dialog-in relative flex w-full flex-col overflow-hidden rounded-b-none md:rounded-b-2xl", tall ? "h-[88dvh] md:h-auto md:max-h-[76vh]" : "max-h-[88dvh] md:max-h-[76vh]", DIALOG_WIDTHS[size])}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] font-semibold text-text-primary">{title}</h2>
            {description && <p className="mt-1 text-[13px] leading-5 text-text-muted">{description}</p>}
          </div>
          <DocsIconButton icon={X} label="Close" onClick={onClose} disabled={busy} className="-mr-1.5 -mt-1" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
