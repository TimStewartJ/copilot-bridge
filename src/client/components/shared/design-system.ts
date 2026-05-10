export const UI = {
  text: {
    pageKicker: "inline-flex items-center gap-2 text-xs font-medium text-text-secondary",
    pageTitle: "text-2xl font-semibold leading-tight tracking-tight text-text-primary md:text-3xl",
    pageDescription: "max-w-3xl text-sm leading-relaxed text-text-muted",
    sectionTitle: "flex items-center gap-1.5 text-sm font-semibold tracking-tight text-text-primary",
    sectionLabel: "px-3 py-1.5 text-xs font-semibold tracking-wide text-text-secondary",
    eyebrow: "text-xs font-medium text-text-muted",
    metricLabel: "text-[11px] font-medium tracking-wide text-text-muted",
  },
  surface: {
    card: "rounded-xl border border-border/80 bg-bg-secondary/80 shadow-sm",
    cardInset: "rounded-lg border border-border/70 bg-bg-surface",
    selectedRow: "bg-accent-surface ring-1 ring-accent-border",
    hoverRow: "hover:bg-bg-hover",
  },
  button: {
    primary: "rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:bg-bg-hover disabled:text-text-faint disabled:hover:bg-bg-hover",
    secondary: "rounded-md bg-bg-hover px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-border",
    link: "font-medium text-accent transition-colors hover:text-accent-hover",
  },
  chip: {
    selected: "border border-accent-border bg-accent-surface text-accent",
    info: "border border-info-border bg-info-surface text-info",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    muted: "bg-text-muted/15 text-text-muted",
    faint: "bg-text-faint/15 text-text-faint",
  },
} as const;
