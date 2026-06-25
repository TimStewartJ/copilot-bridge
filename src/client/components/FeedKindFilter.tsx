import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { FeedKindStats } from "../api";

export type FeedKindVizMode = "bars" | "trend" | "heat";

const VIZ_STORAGE_KEY = "bridge-feed-kind-viz";
const VIZ_MODES: FeedKindVizMode[] = ["bars", "trend", "heat"];
const VIZ_LABELS: Record<FeedKindVizMode, string> = { bars: "Bars", trend: "Trend", heat: "Heat" };
const ALL_KINDS_LABEL = "All kinds";
const DEFAULT_BUCKET_COUNT = 14;
const DORMANT_COLLAPSE_THRESHOLD = 5;

const KIND_HUES: Record<string, string> = {
  note: "#a1a1aa",
  status: "#38bdf8",
  todo: "#3b82f6",
  decision: "#a78bfa",
  artifact: "#22c55e",
  link: "#eab308",
  alert: "#ef4444",
  reminder: "#f97316",
};

function kindColor(kind: string): string {
  const mapped = KIND_HUES[kind];
  if (mapped) return mapped;
  let hash = 0;
  for (let index = 0; index < kind.length; index += 1) {
    hash = (hash * 31 + kind.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 65% 60%)`;
}

function maxOf(values: number[]): number {
  return values.reduce((max, value) => (value > max ? value : max), 1);
}

function readVizMode(): FeedKindVizMode {
  try {
    if (typeof localStorage === "undefined") return "bars";
    const stored = localStorage.getItem(VIZ_STORAGE_KEY);
    if (stored === "bars" || stored === "trend" || stored === "heat") return stored;
  } catch {
    /* localStorage may be unavailable; fall back silently */
  }
  return "bars";
}

function persistVizMode(mode: FeedKindVizMode): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(VIZ_STORAGE_KEY, mode);
  } catch {
    /* ignore persistence failures */
  }
}

interface KindRow {
  key: string;
  label: string;
  total: number | null;
  active: number | null;
  buckets: number[];
  hue: string;
}

function BarsViz({ values, hue }: { values: number[]; hue: string }) {
  const max = maxOf(values);
  return (
    <div className="flex h-full w-full items-end gap-px" aria-hidden="true">
      {values.map((value, index) => (
        <span
          key={index}
          className="flex-1 rounded-t-sm"
          style={{ height: `${Math.max(8, Math.round((value / max) * 100))}%`, background: hue, opacity: 0.9 }}
        />
      ))}
    </div>
  );
}

function HeatViz({ values, hue }: { values: number[]; hue: string }) {
  const max = maxOf(values);
  return (
    <div className="flex h-full w-full items-center gap-px" aria-hidden="true">
      {values.map((value, index) => (
        <span
          key={index}
          className="h-3 flex-1 rounded-sm"
          style={{ background: hue, opacity: 0.14 + (value / max) * 0.86 }}
        />
      ))}
    </div>
  );
}

function TrendViz({ values, hue }: { values: number[]; hue: string }) {
  const gradientId = useId();
  const width = 120;
  const height = 28;
  const max = maxOf(values);
  const count = values.length;
  const points = values.map((value, index) => {
    const x = count <= 1 ? width : (index / (count - 1)) * width;
    const y = height - 3 - (value / max) * (height - 7);
    return [x, y] as const;
  });
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={hue} stopOpacity={0.35} />
          <stop offset="1" stopColor={hue} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke={hue}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RowViz({ mode, values, hue }: { mode: FeedKindVizMode; values: number[]; hue: string }) {
  if (mode === "trend") return <TrendViz values={values} hue={hue} />;
  if (mode === "heat") return <HeatViz values={values} hue={hue} />;
  return <BarsViz values={values} hue={hue} />;
}

interface FeedKindFilterProps {
  value: string;
  onChange: (kind: string) => void;
  fallbackKinds: string[];
  stats?: FeedKindStats | null;
  statsLoading?: boolean;
}

export default function FeedKindFilter({
  value,
  onChange,
  fallbackKinds,
  stats = null,
  statsLoading = false,
}: FeedKindFilterProps) {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string>(value);
  const [vizMode, setVizMode] = useState<FeedKindVizMode>(() => readVizMode());
  const [showDormant, setShowDormant] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  const bucketCount = stats?.bucketCount ?? DEFAULT_BUCKET_COUNT;

  const { allRow, activeRows, dormantRows } = useMemo(() => {
    const emptyBuckets = () => new Array<number>(bucketCount).fill(0);
    const byKind = new Map<string, KindRow>();
    if (stats) {
      for (const stat of stats.kinds) {
        byKind.set(stat.kind, {
          key: stat.kind,
          label: stat.kind,
          total: stat.total,
          active: stat.active,
          buckets: stat.buckets.length ? stat.buckets : emptyBuckets(),
          hue: kindColor(stat.kind),
        });
      }
    }
    for (const kind of fallbackKinds) {
      if (!kind || byKind.has(kind)) continue;
      byKind.set(kind, { key: kind, label: kind, total: null, active: null, buckets: emptyBuckets(), hue: kindColor(kind) });
    }
    if (value && !byKind.has(value)) {
      byKind.set(value, { key: value, label: value, total: null, active: null, buckets: emptyBuckets(), hue: kindColor(value) });
    }
    const kindRows = [...byKind.values()].sort((a, b) => {
      const aHas = a.total !== null;
      const bHas = b.total !== null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && bHas) {
        const aActive = a.active ?? 0;
        const bActive = b.active ?? 0;
        if (aActive !== bActive) return bActive - aActive;
        if (a.total !== b.total) return (b.total as number) - (a.total as number);
      }
      return a.label.localeCompare(b.label);
    });
    const isDormant = (row: KindRow) => row.active === 0;
    return {
      allRow: {
        key: "",
        label: ALL_KINDS_LABEL,
        total: stats?.total ?? null,
        active: stats?.active ?? null,
        buckets: stats?.buckets?.length ? stats.buckets : emptyBuckets(),
        hue: "#3b82f6",
      } as KindRow,
      activeRows: kindRows.filter((row) => !isDormant(row)),
      dormantRows: kindRows.filter(isDormant),
    };
  }, [stats, fallbackKinds, value, bucketCount]);

  const shouldCollapseDormant = dormantRows.length >= DORMANT_COLLAPSE_THRESHOLD;
  const pinnedDormant = shouldCollapseDormant ? dormantRows.filter((row) => row.key === value) : [];
  const collapsibleDormant = shouldCollapseDormant ? dormantRows.filter((row) => row.key !== value) : [];
  const listedDormant = shouldCollapseDormant
    ? [...pinnedDormant, ...(showDormant ? collapsibleDormant : [])]
    : dormantRows;
  const hiddenDormantCount = shouldCollapseDormant && !showDormant ? collapsibleDormant.length : 0;
  const archivedDormantTotal = collapsibleDormant.reduce((sum, row) => sum + (row.total ?? 0), 0);

  const rows = useMemo(
    () => [allRow, ...activeRows, ...listedDormant],
    [allRow, activeRows, listedDormant],
  );

  const selectedIndex = Math.max(0, rows.findIndex((row) => row.key === value));
  const selectedRow = rows[selectedIndex] ?? rows[0];
  const activeIndexFromKey = rows.findIndex((row) => row.key === activeKey);
  const activeIndex = activeIndexFromKey >= 0 ? activeIndexFromKey : selectedIndex;

  useEffect(() => {
    if (open) listboxRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const handlePointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  const openMenu = () => {
    setActiveKey(value);
    setShowDormant(false);
    setOpen(true);
  };

  const closeMenu = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  const selectRow = (key: string) => {
    onChange(key);
    closeMenu();
  };

  const moveActive = (delta: number) => {
    const base = activeIndexFromKey >= 0 ? activeIndexFromKey : selectedIndex;
    const next = Math.min(Math.max(base + delta, 0), Math.max(rows.length - 1, 0));
    setActiveKey(rows[next]?.key ?? "");
  };

  const handleFocusLeave = (event: FocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const next = event.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    setOpen(false);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu();
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveKey(rows[0]?.key ?? "");
        break;
      case "End":
        event.preventDefault();
        setActiveKey(rows[rows.length - 1]?.key ?? "");
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const row = rows[activeIndex];
        if (row) selectRow(row.key);
        break;
      }
      case "Escape":
        event.preventDefault();
        closeMenu();
        break;
      default:
        break;
    }
  };

  const chooseViz = (mode: FeedKindVizMode) => {
    setVizMode(mode);
    persistVizMode(mode);
  };

  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const selectedLabel = value ? value : ALL_KINDS_LABEL;
  const selectedActive = selectedRow?.active ?? null;
  const windowDays = stats?.windowDays ?? 30;
  const kindCount = activeRows.length + dormantRows.length;

  const renderOption = (row: KindRow, index: number) => {
    const selected = row.key === value;
    const isActive = index === activeIndex;
    const isAll = row.key === "";
    const dormant = row.active === 0;
    const hasCounts = row.total !== null && row.active !== null;
    const meta = hasCounts
      ? isAll
        ? `${kindCount} ${kindCount === 1 ? "type" : "types"} · ${row.active} active`
        : `${row.active} active · ${(row.total as number) - (row.active as number)} resolved`
      : statsLoading
        ? "Loading…"
        : "No recent updates";
    const optionLabel = hasCounts
      ? `${row.label}, ${row.active} active, ${row.total} total`
      : row.label;
    return (
      <div
        key={row.key || "__all__"}
        id={optionId(index)}
        role="option"
        data-kind={row.key}
        data-dormant={dormant ? "true" : undefined}
        aria-selected={selected}
        aria-label={optionLabel}
        onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.preventDefault()}
        onClick={() => selectRow(row.key)}
        onMouseEnter={() => setActiveKey(row.key)}
        className={`grid cursor-pointer grid-cols-[16px_10px_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg px-2 py-2 transition-opacity ${
          selected ? "bg-accent-surface ring-1 ring-accent-border" : isActive ? "bg-bg-hover" : ""
        } ${dormant && !selected ? "opacity-55 hover:opacity-100" : ""}`}
      >
        <span className="flex justify-center" aria-hidden="true">
          {selected ? <Check size={13} className="text-accent" /> : null}
        </span>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: row.hue }} aria-hidden="true" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-text-primary">{row.label}</div>
          <div className="truncate text-[10.5px] text-text-faint">{meta}</div>
        </div>
        <div className="flex h-[26px] w-[110px] items-end justify-end">
          <RowViz mode={vizMode} values={row.buckets} hue={row.hue} />
        </div>
        <div className="flex min-w-[44px] flex-col items-end">
          <span
            className={`text-[13px] tabular-nums ${
              dormant ? "font-semibold text-text-faint" : "font-bold text-text-primary"
            }`}
          >
            {row.active ?? "—"}
          </span>
          {row.total !== null && <span className="text-[10px] text-text-muted">{row.total} total</span>}
        </div>
      </div>
    );
  };

  const dormantHeaderIndexOffset = 1 + activeRows.length;

  return (
    <div ref={rootRef} className="relative" onBlur={handleFocusLeave}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter feed by kind"
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-bg-surface px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-hover focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <Search size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
        <span className="font-medium">{selectedLabel}</span>
        {selectedActive !== null && (
          <span className="rounded-full bg-bg-hover px-1.5 text-[11px] font-semibold text-text-secondary">
            {selectedActive}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-30 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl">
          <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
            <div className="flex flex-col">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Filter by type</span>
              <span className="text-[11px] text-text-faint">Last {windowDays} days · updates</span>
            </div>
            <div
              className="inline-flex rounded-lg border border-border bg-bg-surface p-0.5"
              role="group"
              aria-label="Activity display"
            >
              {VIZ_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={vizMode === mode}
                  onMouseDown={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
                  onClick={() => chooseViz(mode)}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                    vizMode === mode ? "bg-bg-hover text-text-primary" : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {VIZ_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>

          <div
            ref={listboxRef}
            id={`${baseId}-listbox`}
            role="listbox"
            aria-label="Feed kinds"
            aria-activedescendant={optionId(activeIndex)}
            tabIndex={-1}
            onKeyDown={onListKeyDown}
            className="max-h-[360px] overflow-auto p-1.5 focus:outline-none"
          >
            {renderOption(allRow, 0)}
            {activeRows.map((row, index) => renderOption(row, 1 + index))}
            {listedDormant.length > 0 && (
              <div
                className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-faint"
                aria-hidden="true"
              >
                Dormant · 0 active
              </div>
            )}
            {listedDormant.map((row, index) => renderOption(row, dormantHeaderIndexOffset + index))}
          </div>

          {shouldCollapseDormant && (
            <button
              type="button"
              aria-expanded={showDormant}
              aria-controls={`${baseId}-listbox`}
              onMouseDown={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
              onClick={() => setShowDormant((value) => !value)}
              className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
            >
              <ChevronDown
                size={14}
                className={`transition-transform ${showDormant ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
              {showDormant
                ? "Hide inactive types"
                : `Show ${hiddenDormantCount} inactive ${hiddenDormantCount === 1 ? "type" : "types"}`}
              {!showDormant && archivedDormantTotal > 0 && (
                <span className="ml-auto text-[10px] text-text-faint">{archivedDormantTotal} archived</span>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
