/**
 * Bridge design system: the class recipes every screen is built from.
 *
 * Read README.md in this folder first. It holds the rules; this file holds the one place each rule
 * is spelled out in classes, so a screen that uses these cannot drift from the others. Colours come
 * from the theme variables in index.css and are referred to by role, never by value, so both themes
 * keep working.
 *
 * Every class below is written out in full because Tailwind finds classes by scanning source text.
 * Do not build class names from pieces.
 */

/** Keyboard focus, identical on every interactive element. */
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
const GROUP_SURFACE = "rounded-xl border border-surface-edge bg-surface-group";
const INSET_SURFACE = "rounded-lg border border-surface-edge bg-surface-inset";
const SHEET = "relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border border-surface-edge bg-surface-overlay shadow-2xl shadow-black/30 md:mb-16 md:mt-16 md:max-h-[80vh] md:rounded-2xl";
const NOTICE_SURFACE = `${INSET_SURFACE} px-3 py-2 text-xs leading-relaxed text-text-secondary`;

export const DS = {
  focus: FOCUS,

  /**
   * Text roles. Content is the only full-contrast text on a screen; every label, detail and figure
   * around it is one step quieter than the thing it describes.
   */
  text: {
    /** What the reader came for: a reply, a task's brief, a document. */
    content: "text-sm leading-[1.7] text-text-primary",
    /** The name of the screen or object being looked at. */
    title: "text-lg font-semibold leading-snug tracking-tight text-text-primary",
    /** A large title for a full-page view. */
    pageTitle: "text-2xl font-semibold leading-tight tracking-tight text-text-primary",
    /** The content title of an object in Focus, search or a document list. */
    objectTitle: "text-base font-medium leading-snug text-text-primary",
    /** The label of a section: what the rows beneath it are. */
    sectionLabel: "text-xs font-medium text-text-secondary",
    /** The heading of a section on a full-page view, where sections are the page's outline. */
    sectionTitle: "text-sm font-semibold tracking-tight text-text-primary",
    /** The label of a row: what happened, or what this is. */
    rowLabel: "text-[13px] text-text-secondary",
    /** What a row acted on, or the value beside a label. */
    rowDetail: "text-[13px] text-text-muted",
    /** Literal input shown as itself: a command, a path, a pattern. */
    literal: "font-mono text-[12px] text-text-muted",
    /** Counts, durations, timestamps. Tabular so a ticking number does not jitter. */
    meta: "text-xs tabular-nums text-text-faint",
    /** The label inside a detail panel. The only place capitals are used. */
    eyebrow: "text-[10px] font-medium uppercase tracking-wider text-text-faint",
    /** Secondary prose: thinking, descriptions, help. */
    prose: "text-[13px] leading-relaxed text-text-muted",
    /** A state that is absent, said once and quietly instead of drawn as an empty box. */
    empty: "text-xs text-text-secondary",
    /** The label of something that is waiting on the reader: a question, an approval. */
    attention: "text-xs font-medium text-accent",
  },

  /**
   * A row: one line that says what something is, and may open to show more. The negative margin
   * lets the hover fill extend past the text so the text itself stays on the column's left edge.
   */
  row: {
    base: `-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors ${FOCUS}`,
    /** A multi-line navigation result or history entry must grow with its content. */
    stacked: `block w-full min-w-0 rounded-lg px-3 py-3 text-left text-[13px] transition-colors hover:bg-surface-selected ${FOCUS}`,
    /** A row that hugs its content, for a line that stands alone between paragraphs. */
    inline: `-mx-1.5 inline-flex max-w-[calc(100%+0.75rem)] min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left align-top text-[13px] transition-colors ${FOCUS}`,
    interactive: "cursor-pointer hover:bg-bg-hover/60",
    /** Navigation and list controls need a full touch target, even when the value is short. */
    touch: "min-h-10 md:min-h-7",
    inert: "cursor-default",
    /** The current item in a list. Selection is a neutral fill; accent is kept for unread and focus. */
    selected: "bg-surface-selected text-text-primary",
    /** The label keeps its width; the detail takes what is left and truncates first. */
    label: "min-w-0 shrink truncate",
    detail: "min-w-0 flex-1 truncate",
    /** Right-aligned figures and the chevron. */
    trailing: "ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] tabular-nums text-text-faint",
    iconSlot: "flex h-4 w-4 shrink-0 items-center justify-center",
    chevron: "shrink-0 text-text-faint transition-transform duration-150",
    chevronOpen: "rotate-90",
  },

  /** Content opened beneath a row hangs from a hairline rail instead of sitting in a box. */
  rail: "ml-[5px] mt-1 border-l border-border pl-4",

  /**
   * A native <details> drawn as a row, for a disclosure that needs no state of its own. The
   * browser's marker is replaced by the chevron every other row uses.
   */
  details: {
    root: "group/details min-w-0",
    summary: `-mx-1.5 flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-bg-hover/60 [&::-webkit-details-marker]:hidden ${FOCUS}`,
    chevron: "shrink-0 text-text-faint transition-transform duration-150 group-open/details:rotate-90",
  },

  /** Opaque surface levels show hierarchy; rows and values remain unboxed within one group. */
  surface: {
    /** Workspace behind the panes and content groups. */
    canvas: "bg-surface-canvas",
    /** Persistent navigation and inspectors are distinct from their content groups. */
    pane: "bg-surface-pane",
    /** One logical region: a task's Momentum, its session list or a settings section. */
    group: GROUP_SURFACE,
    /** A self-contained object to act on. Do not nest Panels or same-level groups. */
    panel: GROUP_SURFACE,
    /** Raw detail opened from a row is an inset, not another raised group. */
    detail: INSET_SURFACE,
    inset: INSET_SURFACE,
    selected: "bg-surface-selected text-text-primary",
    /** Something that floats above the page: a menu, the composer, a jump button. */
    floating: "rounded-xl border border-surface-edge bg-surface-overlay shadow-lg shadow-black/10",
    /** Words that float over a list to say what is off screen and jump there. */
    floatingPill: "inline-flex items-center gap-2 rounded-full border border-surface-edge bg-surface-overlay py-1.5 pl-2.5 pr-3 text-xs font-medium text-text-primary shadow-lg shadow-black/10 transition-colors hover:bg-surface-selected",
    /** The shadow alone, for a floating control with a shape of its own, such as a round button. */
    lift: "shadow-lg shadow-black/10",
    /** The message composer: the one floating surface that is always on screen. */
    composer: "rounded-2xl border border-control-edge bg-surface-group shadow-lg shadow-black/10 transition-colors focus-within:border-text-secondary",
    /** A dialog, and the scrim that holds the page back while it is open. */
    dialog: "rounded-2xl border border-surface-edge bg-surface-overlay shadow-2xl shadow-black/30",
    /** Long content opened over the page: a sheet from the bottom on a phone, a dialog on a desktop. */
    sheet: `${SHEET} md:max-w-2xl`,
    compactSheet: `${SHEET} md:max-w-lg`,
    scrim: "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
    /** Hairlines between the rows of one list. */
    divided: "divide-y divide-border-subtle",
    hairline: "border-surface-edge",
  },

  /**
   * Buttons. One primary action per screen, and on a chat screen it is Send. Everything else is
   * secondary (a quiet fill) or ghost (text). Accent colour is never used as a fill.
   */
  button: {
    base: `inline-flex shrink-0 items-center justify-center font-medium transition-colors disabled:cursor-not-allowed ${FOCUS}`,
    size: {
      sm: "h-10 gap-1.5 rounded-md px-2.5 text-xs md:h-7",
      md: "h-10 gap-2 rounded-lg px-3 text-[13px] md:h-9",
    },
    variant: {
      primary: "bg-text-primary text-bg-primary hover:opacity-85 disabled:bg-bg-hover disabled:text-text-faint disabled:opacity-100",
      secondary: "bg-bg-hover/70 text-text-primary hover:bg-bg-hover disabled:bg-bg-hover/40 disabled:text-text-faint",
      ghost: "text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary disabled:text-text-faint disabled:hover:bg-transparent",
      danger: "text-error hover:bg-error/10 disabled:text-text-faint disabled:hover:bg-transparent",
    },
    /** A square button that holds only an icon. It must carry an aria-label. */
    icon: {
      sm: "h-10 w-10 rounded-md md:h-7 md:w-7",
      md: "h-10 w-10 rounded-lg md:h-9 md:w-9",
    },
  },

  /** A choice between a few options, shown as one control instead of a row of separate buttons. */
  segmented: {
    group: "inline-flex items-center gap-0.5 rounded-lg border border-border bg-bg-secondary p-0.5",
    groupFull: "flex w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-bg-secondary p-0.5",
    option: `inline-flex min-w-0 items-center justify-center gap-1 rounded-md px-1.5 font-medium transition-colors sm:px-2.5 ${FOCUS}`,
    optionSize: {
      sm: "h-10 text-[11px] md:h-6",
      md: "h-10 text-[13px] md:h-8",
    },
    optionFull: "min-w-fit flex-1",
    selected: "bg-surface-selected text-text-primary",
    unselected: "text-text-secondary enabled:hover:text-text-primary",
    disabled: "disabled:cursor-default",
  },

  /**
   * Options that may be many, long, or chosen several at a time, so they wrap instead of sharing
   * one segmented control. Selection is the same neutral fill.
   */
  choice: {
    group: "flex flex-wrap gap-1.5",
    option: `inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-lg border px-3 py-1.5 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9 ${FOCUS}`,
    selected: "border-control-edge bg-surface-selected text-text-primary",
    unselected: "border-border text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary",
  },

  /**
   * A badge names a state in a word or two. Colour sits on the words that carry the state and
   * nowhere else: a tinted box around a whole section is not a badge.
   */
  badge: {
    base: "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
    tone: {
      neutral: "bg-bg-hover text-text-secondary",
      accent: "bg-accent-surface text-accent",
      info: "bg-info-surface text-info",
      success: "bg-success-surface text-success",
      warning: "bg-warning-surface text-warning",
      danger: "bg-error-surface text-error",
    },
  },

  /**
   * A tag is a name the user chose, in the colour the user chose (tag-colors.ts). It has the shape
   * of a badge, a size smaller, so that it reads as a label and not as a state.
   */
  tag: {
    base: "inline-flex min-w-0 items-center gap-1 rounded-md font-medium leading-none",
    size: {
      xs: "px-1.5 py-[3px] text-[10px]",
      sm: "px-2 py-1 text-xs",
    },
    /** A tag that comes from the task's group and cannot be removed here. */
    inherited: "opacity-75 ring-1 ring-current/20",
  },

  /**
   * A count that wants attention: unread results, questions waiting. It is the one coloured fill in
   * the system, because here the number is the state. The figure takes the page colour so it reads
   * on a bright fill in either theme.
   */
  count: {
    base: "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none tabular-nums text-bg-primary",
    /** Horizontal room for two digits, kept apart from `base` so a single digit stays round. */
    pad: "px-[5px]",
    tone: {
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-error",
      neutral: "bg-text-muted",
    },
  },

  /** A small dot that stands for a state or an identity beside a name. Pair it with a colour class. */
  dot: "inline-block h-1.5 w-1.5 shrink-0 rounded-full",

  /** A band names a loaded collection without turning each row into another surface. */
  collection: {
    header: "flex min-h-10 min-w-0 items-center border-b border-surface-edge bg-surface-inset md:min-h-8",
  },

  /** Scannable usage rows: one model, its figures, and a breakdown on demand. */
  usage: {
    rowSummary: "-mx-1.5 flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1.5 py-2 text-[13px] transition-colors hover:bg-bg-hover/60 [&::-webkit-details-marker]:hidden",
    figures: "flex min-w-0 basis-full flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 pl-[25px] text-xs tabular-nums text-text-secondary @[28rem]/usage-models:ml-auto @[28rem]/usage-models:basis-auto @[28rem]/usage-models:justify-end @[28rem]/usage-models:pl-0",
    value: "font-medium tabular-nums text-text-primary",
    /** Source and coverage qualifiers are needed to interpret a figure, not optional decoration. */
    meta: "text-xs tabular-nums text-text-secondary",
    prose: "text-[13px] leading-relaxed text-text-secondary",
  },

  /** A proportion drawn as a bar. The fill is neutral: a chart is not a call to action. */
  meter: {
    track: "h-1.5 overflow-hidden rounded-full bg-bg-hover",
    fill: "h-full rounded-full bg-text-muted",
  },

  /** State colour for an icon or a few words, when no badge is wanted. */
  tone: {
    neutral: "text-text-muted",
    accent: "text-accent",
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    danger: "text-error",
  },

  /**
   * Text inputs and selects. The text is 16px on a phone because iOS zooms the page when a smaller
   * field takes focus.
   */
  field: {
    input: `w-full rounded-lg border border-control-edge bg-surface-inset px-3 text-base text-text-primary placeholder:text-text-faint transition-colors focus:border-text-secondary focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 md:text-[13px]`,
    inputSize: { sm: "h-10 md:h-8", md: "h-10 md:h-9" },
    textarea: "py-2 leading-relaxed",
    /** Generic fields shared by inputs, selects and textareas must not force a textarea height. */
    control: "min-h-10 py-2 md:min-h-9 md:py-1.5",
    /** Text inside a compound field, such as search filters, tags or quick Action entry. */
    inline: "min-h-10 min-w-0 flex-1 bg-transparent text-base text-text-primary placeholder:text-text-faint outline-none md:text-[13px]",
    group: "flex min-h-10 min-w-0 flex-wrap items-center gap-2 rounded-lg border border-control-edge bg-surface-inset px-3 py-2 transition-colors focus-within:border-text-secondary",
    label: "text-xs font-medium text-text-secondary",
    help: "text-xs text-text-secondary",
  },

  /** Menu actions and search suggestions share a full-width, touch-safe row. */
  menu: {
    item: `flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:text-text-faint md:min-h-8 ${FOCUS}`,
    selected: "bg-bg-hover text-text-primary",
    divider: "my-1 border-t border-border-subtle",
  },

  /** Native selection controls used by settings and voice forms. */
  control: {
    checkbox: `size-4 shrink-0 rounded accent-text-primary disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`,
  },

  /** Inline notices keep their surface neutral; state belongs to their icon or title. */
  notice: {
    base: `flex items-start gap-2.5 ${NOTICE_SURFACE}`,
    /** Existing status regions that own their DOM composition share the surface, not flex layout. */
    surface: NOTICE_SURFACE,
  },

  /** A tick box drawn by hand, for a row that is itself the button. Ticked is a neutral fill. */
  checkbox: {
    base: "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] leading-none transition-colors",
    checked: "border-text-primary bg-text-primary text-bg-primary",
    unchecked: "border-border",
  },

  /** Motion says something is alive. It is never decoration, and index.css turns it off on request. */
  motion: {
    /** The label of work that is still happening. */
    live: "shimmer-text",
    /** Content appearing beneath a row. */
    reveal: "ds-reveal",
  },

  /** The readable column shared by the transcript and the composer. */
  layout: {
    readingColumn: "mx-auto w-full max-w-4xl px-3 sm:px-4 md:px-6 lg:px-8",
    /** A full-page view such as a task overview. */
    pageColumn: "mx-auto w-full max-w-5xl px-4 py-5 md:px-8 md:py-7",
    /** One quiet line of chrome on the page's background. Its container owns the bottom hairline. */
    headerBar: "flex min-h-10 shrink-0 items-center gap-2 px-3 text-xs text-text-muted sm:px-4",
    /** One neutral group per dashboard or inspector region; its rows and values stay unboxed. */
    section: `${GROUP_SURFACE} min-w-0 p-3 sm:p-4`,
    formGroup: "min-w-0 space-y-4",
    /** Domain objects in Focus, configuration and search lists are separated by one hairline. */
    objectRow: "min-w-0 border-b border-border-subtle py-4 last:border-b-0",
  },
} as const;

export type DsTone = keyof typeof DS.tone;
export type DsButtonVariant = keyof typeof DS.button.variant;
export type DsButtonSize = keyof typeof DS.button.size;

/** Join class fragments, dropping the ones a condition switched off. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
