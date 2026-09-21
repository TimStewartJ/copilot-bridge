import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import { DS, cx, type DsButtonSize, type DsButtonVariant, type DsTone } from "./tokens";

/**
 * Bridge design system: the components screens are assembled from. README.md in this folder holds
 * the rules. Reach for one of these before writing a class string; add to this file, not to a
 * screen, when something a second screen will need is missing.
 */

// ── Actions ─────────────────────────────────────────────────────────────────

interface ButtonProps extends ComponentProps<"button"> {
  /** `primary` is the one action a screen exists for. There is at most one, and chat's is Send. */
  variant?: DsButtonVariant;
  size?: DsButtonSize;
  icon?: ReactNode;
  fullWidth?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  fullWidth = false,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(DS.button.base, DS.button.size[size], DS.button.variant[variant], fullWidth && "w-full", className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<ComponentProps<"button">, "aria-label"> {
  /** An icon alone says nothing to a screen reader, so the label is required. */
  label: string;
  variant?: Exclude<DsButtonVariant, "primary">;
  size?: keyof typeof DS.button.icon;
}

export function IconButton({
  label,
  variant = "ghost",
  size = "sm",
  className,
  children,
  type = "button",
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx(DS.button.base, DS.button.icon[size], DS.button.variant[variant], className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  /** A null value is an inert inherited/default placeholder, selected when `value` is undefined. */
  value: T | null;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** A choice between a few options. Selection is a neutral fill, not an accent outline. */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  onReselect,
  size = "md",
  fullWidth = false,
  disabled = false,
  className,
}: {
  ariaLabel: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T | undefined;
  onChange: (value: T) => void;
  /** Some controls treat reselecting a value as an explicit override of an inherited default. */
  onReselect?: (value: T) => void;
  size?: keyof typeof DS.segmented.optionSize;
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx(fullWidth ? DS.segmented.groupFull : DS.segmented.group, disabled && "opacity-60", className)}
    >
      {options.map((option) => {
        const selected = option.value === null ? value === undefined : option.value === value;
        return (
          <button
            key={option.value ?? "__inherited_default__"}
            type="button"
            aria-pressed={selected}
            disabled={disabled || option.disabled || option.value === null}
            title={option.title}
            onClick={() => {
              if (option.value === null || disabled || option.disabled) return;
              if (selected) onReselect?.(option.value);
              else onChange(option.value);
            }}
            className={cx(
              DS.segmented.option,
              DS.segmented.optionSize[size],
              fullWidth && DS.segmented.optionFull,
              selected ? DS.segmented.selected : DS.segmented.unselected,
              DS.segmented.disabled,
            )}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One of several options that wrap: answers to a question, values of a multi-select. Pass
 * `selected` when the option holds a state; leave it out when pressing the option is the answer.
 */
export function ChoiceButton({
  selected,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cx(DS.choice.option, selected ? DS.choice.selected : DS.choice.unselected, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── Fields ──────────────────────────────────────────────────────────────────

export function TextInput({
  inputSize = "md",
  className,
  ...rest
}: ComponentProps<"input"> & { inputSize?: keyof typeof DS.field.inputSize }) {
  return <input className={cx(DS.field.input, DS.field.inputSize[inputSize], className)} {...rest} />;
}

export function TextArea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cx(DS.field.input, DS.field.textarea, className)} {...rest} />;
}

export function Select({
  inputSize = "md",
  className,
  children,
  ...rest
}: ComponentProps<"select"> & { inputSize?: keyof typeof DS.field.inputSize }) {
  return (
    <select className={cx(DS.field.input, DS.field.inputSize[inputSize], className)} {...rest}>
      {children}
    </select>
  );
}

/**
 * A labelled control: the label beside it when its container has room, above it otherwise. Pass
 * `htmlFor` when the control is a single field; a group of buttons names itself with aria-label.
 */
export function FormRow({
  label,
  htmlFor,
  hideLabel = false,
  help,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  /** Hide a redundant visible label without losing its accessible name or reserving a label column. */
  hideLabel?: boolean;
  help?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const labelClass = hideLabel ? "sr-only" : cx(DS.field.label, "@[28rem]/form-row:pt-2.5");
  return (
    <div className={cx("@container/form-row min-w-0", className)}>
      <div className={cx("grid gap-1.5", !hideLabel && "@[28rem]/form-row:grid-cols-[5.5rem_minmax(0,1fr)] @[28rem]/form-row:gap-4")}>
        {htmlFor ? <label htmlFor={htmlFor} className={labelClass}>{label}</label> : <div className={labelClass}>{label}</div>}
        <div className="min-w-0 space-y-1.5">
          {children}
          {help && <p className={DS.field.help}>{help}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Structure ───────────────────────────────────────────────────────────────

/**
 * A labelled group of rows. It draws no box: the label and the space around it do the grouping.
 */
export function Section({
  label,
  count,
  action,
  level = "group",
  surface = false,
  children,
  className,
  labelClassName,
}: {
  label: ReactNode;
  /** A figure that belongs to the label, such as how many rows follow or "3/7". */
  count?: ReactNode;
  action?: ReactNode;
  /** `page` is a heading in a full-page view's outline; `group` labels rows in a panel. */
  level?: "group" | "page";
  /** Give a significant region one group surface; never box its individual values or nest groups. */
  surface?: boolean;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
}) {
  const headingId = useId();
  const Heading = level === "page" ? "h2" : "h3";
  return (
    <section aria-labelledby={headingId} data-ds-surface={surface ? "group" : undefined} className={cx(surface && DS.layout.section, className)}>
      <div className={cx("flex items-center justify-between gap-2", level === "page" ? "mb-2 min-h-8" : "min-h-7", labelClassName)}>
        <Heading id={headingId} className={level === "page" ? DS.text.sectionTitle : DS.text.sectionLabel}>
          {label}
          {count !== undefined && count !== null && (
            <span className="ml-1.5 font-normal tabular-nums text-text-faint">{count}</span>
          )}
        </Heading>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The one bordered container. Never put one inside another; use a rail or hairlines instead. */
export function Panel({
  children,
  className,
  padded = true,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div className={cx(DS.surface.panel, padded && "px-4 py-3", className)} data-ds-panel="" {...rest}>
      {children}
    </div>
  );
}

/**
 * One line that says what something is and opens to show more. Closed by default: the reader
 * chooses what to open. Pass `expanded` and `onToggle` to control it from outside.
 */
export function DisclosureRow({
  label,
  detail,
  detailMono = false,
  meta,
  icon,
  live = false,
  tone,
  expanded: controlledExpanded,
  defaultExpanded = false,
  onToggle,
  disabled = false,
  inline = false,
  children,
  title,
  className,
}: {
  label: ReactNode;
  detail?: ReactNode;
  detailMono?: boolean;
  /** Figures at the end of the line: a count, a duration. */
  meta?: ReactNode;
  icon?: ReactNode;
  /** The work this row stands for is still happening. */
  live?: boolean;
  tone?: DsTone;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onToggle?: (expanded: boolean) => void;
  /** Nothing to open. The row is still shown, without a chevron. */
  disabled?: boolean;
  /** Hug the content instead of spanning the column. */
  inline?: boolean;
  children?: ReactNode;
  title?: string;
  className?: string;
}) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const expanded = !disabled && (controlledExpanded ?? uncontrolledExpanded);
  const contentId = useId();
  const toggle = () => {
    if (disabled) return;
    if (controlledExpanded === undefined) setUncontrolledExpanded(!expanded);
    onToggle?.(!expanded);
  };

  return (
    <div className={cx("min-w-0", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={disabled ? undefined : expanded}
        aria-controls={expanded ? contentId : undefined}
        disabled={disabled}
        title={title}
        className={cx(inline ? DS.row.inline : DS.row.base, disabled ? DS.row.inert : DS.row.interactive)}
      >
        {inline && (
          <ChevronRight
            size={13}
            aria-hidden="true"
            className={cx(DS.row.chevron, expanded && DS.row.chevronOpen, disabled && "opacity-0")}
          />
        )}
        {icon && <span className={DS.row.iconSlot}>{icon}</span>}
        <span className={cx(DS.row.label, live ? DS.motion.live : tone ? DS.tone[tone] : "text-text-secondary", inline && "font-medium")}>
          {label}
        </span>
        {detail !== undefined && detail !== null && detail !== "" && (
          <span className={cx(DS.row.detail, "text-text-muted", detailMono && "font-mono text-[12px]")}>{detail}</span>
        )}
        {(meta || (!inline && !disabled)) && (
          <span className={inline ? "shrink-0 whitespace-nowrap pl-1 text-xs tabular-nums text-text-faint" : DS.row.trailing}>
            {meta}
            {!inline && !disabled && (
              <ChevronRight size={12} aria-hidden="true" className={cx(DS.row.chevron, expanded && DS.row.chevronOpen)} />
            )}
          </span>
        )}
      </button>
      {expanded && (
        <div id={contentId} className={cx(DS.rail, DS.motion.reveal, "pb-1")}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The same line as a DisclosureRow, built on a native <details>. Use it where the open state needs
 * no handling: the browser keeps it, and `open` only sets how it starts.
 */
export function Details({
  label,
  detail,
  tone,
  open,
  children,
  className,
}: {
  label: ReactNode;
  detail?: ReactNode;
  tone?: DsTone;
  open?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details open={open} className={cx(DS.details.root, className)}>
      <summary className={DS.details.summary}>
        <ChevronRight size={13} aria-hidden="true" className={DS.details.chevron} />
        <span className={cx("font-medium", tone ? DS.tone[tone] : "text-text-secondary")}>{label}</span>
        {detail !== undefined && detail !== null && detail !== "" && (
          <span className="min-w-0 truncate text-text-secondary">{detail}</span>
        )}
      </summary>
      <div className={cx(DS.rail, "pb-1")}>{children}</div>
    </details>
  );
}

// ── Information ─────────────────────────────────────────────────────────────

/** A state named in a word or two. */
export function Badge({
  tone = "neutral",
  children,
  title,
  className,
  ...rest
}: ComponentProps<"span"> & { tone?: keyof typeof DS.badge.tone }) {
  return (
    <span {...rest} className={cx(DS.badge.base, DS.badge.tone[tone], className)} title={title}>
      {children}
    </span>
  );
}

/** How many things want attention. Hidden from assistive tech: the control it sits on says it in words. */
export function CountBadge({
  count,
  tone = "success",
  className,
}: {
  count: number;
  tone?: keyof typeof DS.count.tone;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cx(DS.count.base, DS.count.pad, DS.count.tone[tone], className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Facts about something, on one quiet line: "15h ago · 331 KB · 3 sessions". */
export function MetaLine({
  items,
  className,
}: {
  /** Falsy items are skipped, so callers can write `condition && value`. */
  items: ReadonlyArray<ReactNode | false | null | undefined>;
  className?: string;
}) {
  const shown = items.filter((item) => item !== false && item !== null && item !== undefined && item !== "");
  if (shown.length === 0) return null;
  return (
    <div className={cx("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5", DS.usage.meta, className)}>
      {shown.map((item, index) => (
        <span key={index} className="inline-flex min-w-0 items-center gap-1.5">
          {index > 0 && <span aria-hidden="true">·</span>}
          <span className="min-w-0 truncate">{item}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Labelled values as a list with hairlines between them, instead of one box per value. `stacked`
 * puts the label above the value for a narrow column.
 */
export function FieldList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <dl className={cx(DS.surface.divided, className)}>{children}</dl>;
}

export function Field({
  label,
  icon,
  children,
  empty,
  stacked = false,
  action,
  mono = false,
}: {
  label: ReactNode;
  icon?: ReactNode;
  /** The value. When it is missing, `empty` is shown in its place, quietly. */
  children?: ReactNode;
  empty?: ReactNode;
  stacked?: boolean;
  action?: ReactNode;
  mono?: boolean;
}) {
  const hasValue = children !== undefined && children !== null && children !== false && children !== "";
  return (
    <div className={cx("py-2.5 text-[13px] leading-relaxed", !stacked && "grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-4")}>
      <dt className={cx("flex items-center gap-1.5 text-text-secondary", stacked && "mb-0.5 justify-between text-xs")}>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {icon && <span className="shrink-0 text-text-faint">{icon}</span>}
          <span className="min-w-0 break-words">{label}</span>
        </span>
        {stacked && action}
      </dt>
      <dd className={cx("min-w-0 break-words", hasValue ? "text-text-primary" : "text-text-faint", mono && hasValue && "font-mono text-[12px]")}>
        {hasValue ? children : empty}
        {!stacked && action && <span className="ml-2 inline-flex">{action}</span>}
      </dd>
    </div>
  );
}

/** Headline figures set in a row, not in tiles. */
export function StatRow({
  stats,
  className,
}: {
  stats: ReadonlyArray<{ label: string; value: ReactNode; detail?: ReactNode }>;
  className?: string;
}) {
  return (
    <dl className={cx("flex flex-wrap gap-x-8 gap-y-3", className)}>
      {stats.map((stat) => (
        <div key={stat.label} className="flex min-w-0 flex-col">
          <dt className="order-2 mt-0.5 text-xs text-text-secondary">
            {stat.label}
            {stat.detail !== undefined && stat.detail !== null && (
              <span className="text-text-secondary"> · {stat.detail}</span>
            )}
          </dt>
          <dd className="order-1 text-lg font-semibold leading-tight tabular-nums text-text-primary">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Something that is absent, said once and quietly instead of drawn as an empty dashed box. */
export function EmptyHint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx(DS.text.empty, className)}>{children}</p>;
}

/**
 * Something the reader should know. The surface stays neutral; only the icon and the title carry
 * the tone, so a screen with a warning on it does not turn yellow.
 */
export function Notice({
  tone = "info",
  icon,
  title,
  children,
  action,
  role,
  className,
}: {
  tone?: Exclude<DsTone, "accent">;
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
  className?: string;
}) {
  const titleTone = tone === "neutral" ? "text-text-secondary" : DS.tone[tone];
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cx(DS.notice.base, className)}
    >
      {icon && <span className={cx("mt-0.5 shrink-0", DS.tone[tone])}>{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <div className={cx("font-medium", titleTone)}>{title}</div>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
