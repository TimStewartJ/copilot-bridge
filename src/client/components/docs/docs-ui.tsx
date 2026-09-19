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
import { Loader2, X, type LucideIcon } from "lucide-react";
import { useModalDialog } from "../shared/useModalDialog";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

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

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";

// ── Buttons ───────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover disabled:bg-bg-hover disabled:text-text-faint",
  secondary: "border border-border bg-bg-surface text-text-primary hover:bg-bg-hover disabled:text-text-faint",
  ghost: "text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:text-text-faint",
  danger: "bg-error text-white hover:bg-error-hover disabled:bg-bg-hover disabled:text-text-faint",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-[13px]",
  md: "h-9 gap-2 px-3.5 text-sm",
};

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
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        FOCUS_RING,
        className,
      )}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : Icon ? <Icon size={14} /> : null}
      {children}
    </button>
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
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={cx(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        active ? "bg-bg-hover text-text-primary" : "text-text-muted hover:bg-bg-hover hover:text-text-primary",
        FOCUS_RING,
        className,
      )}
    >
      <Icon size={size} />
    </button>
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

const FIELD_BASE =
  "w-full rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-faint transition-colors "
  + "hover:border-text-faint/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

export const DocsInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function DocsInput({ className, invalid, ...rest }, ref) {
    return <input {...rest} ref={ref} aria-invalid={invalid || undefined} className={cx(FIELD_BASE, "h-9", invalid && "border-error/70", className)} />;
  },
);

export const DocsSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function DocsSelect({ className, invalid, children, ...rest }, ref) {
    return (
      <select {...rest} ref={ref} aria-invalid={invalid || undefined} className={cx(FIELD_BASE, "h-9 pr-8", invalid && "border-error/70", className)}>
        {children}
      </select>
    );
  },
);

export const DocsTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function DocsTextarea({ className, invalid, ...rest }, ref) {
    return <textarea {...rest} ref={ref} aria-invalid={invalid || undefined} className={cx(FIELD_BASE, "py-2 leading-6", invalid && "border-error/70", className)} />;
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
  const tones = {
    error: "border-error/30 bg-error/10 text-error",
    warning: "border-warning/30 bg-warning/10 text-text-primary",
    info: "border-info-border bg-info-surface text-text-primary",
  } as const;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3.5 py-2.5 text-[13px] leading-5", tones[tone])}>
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
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
        className={cx(
          "docs-dialog-in relative flex w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-secondary shadow-2xl md:rounded-xl",
          tall ? "h-[88dvh] md:h-auto md:max-h-[76vh]" : "max-h-[88dvh] md:max-h-[76vh]",
          DIALOG_WIDTHS[size],
        )}
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
