import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelInfo, ModelPresets } from "../../api";
import type { ModelPresetSlot } from "../../../shared/model-presets.js";
import {
  resolveModelPresetState,
  type ModelPresetTile,
} from "../../lib/model-presets";
import { formatModelMultiplier } from "./LaunchOptionControls";
import {
  computeMenuPlacement,
  type MenuPlacement,
} from "../../lib/menu-placement";
import { DS, cx } from "../../design/tokens";

function readViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
}

function PresetRefineMenu({
  tile,
  models,
  globalDefaultModelId,
  tileRefs,
  onSelect,
  onClose,
}: {
  tile: ModelPresetTile;
  models: readonly ModelInfo[];
  globalDefaultModelId?: string;
  tileRefs: { current: Partial<Record<ModelPresetSlot, HTMLDivElement | null>> };
  onSelect: (modelId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const slot = tile.slot;

  const reposition = useCallback(() => {
    const anchor = tileRefs.current[slot];
    const menu = menuRef.current;
    if (!anchor?.getBoundingClientRect || !menu?.getBoundingClientRect) return;
    const next = computeMenuPlacement(
      anchor.getBoundingClientRect(),
      menu.getBoundingClientRect(),
      readViewport(),
    );
    setPlacement((prev) => {
      if (prev === next) return prev;
      if (prev && next
        && prev.top === next.top
        && prev.left === next.left
        && prev.minWidth === next.minWidth
        && prev.maxHeight === next.maxHeight) {
        return prev;
      }
      return next;
    });
  }, [slot, tileRefs]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition, models.length]);

  useEffect(() => {
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [reposition]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectedIndex = models.findIndex((model) => model.id === tile.model?.id);
  const initialIndex = selectedIndex >= 0 ? selectedIndex : 0;

  useEffect(() => {
    itemRefs.current[initialIndex]?.focus?.();
    // Focus the current choice once, when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = itemRefs.current.slice(0, models.length).filter((item): item is HTMLButtonElement => Boolean(item));
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus?.();
  };

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={`${tile.label} models`}
      onKeyDown={moveFocus}
      className={cx(
        "z-50 min-w-52 overflow-y-auto overscroll-contain p-1",
        DS.surface.floating,
        placement ? "fixed" : "absolute left-0 top-full mt-1 max-h-64",
      )}
      style={placement
        ? {
          top: placement.top,
          left: placement.left,
          minWidth: placement.minWidth,
          maxHeight: placement.maxHeight,
        }
        : undefined}
    >
      {models.map((model, index) => {
        const selected = model.id === tile.model?.id;
        return (
          <button
            key={model.id}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(model.id)}
            className={cx(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
              DS.focus,
              selected ? DS.row.selected : "text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary",
            )}
          >
            <Check className={cx("h-3 w-3 shrink-0", selected ? "text-text-secondary" : "opacity-0")} aria-hidden="true" />
            <span className="truncate">
              {model.name}{formatModelMultiplier(model.billing?.multiplier)}
            </span>
            {model.id === globalDefaultModelId && (
              <span className="ml-auto shrink-0 pl-2 text-[10px] font-normal text-text-faint">
                default
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function ModelPresetPicker({
  models,
  selectedModelId,
  selectedPresetSlot,
  globalDefaultModelId,
  presets,
  allowUnselected = false,
  disabled = false,
  idPrefix,
  onSelectPreset,
  onSelectModel,
  onSelectionCommitted,
}: {
  models: readonly ModelInfo[];
  selectedModelId: string;
  selectedPresetSlot?: ModelPresetSlot;
  globalDefaultModelId?: string;
  presets?: ModelPresets;
  allowUnselected?: boolean;
  disabled?: boolean;
  idPrefix: string;
  onSelectPreset: (slot: ModelPresetSlot) => void;
  onSelectModel: (slot: ModelPresetSlot, modelId: string) => void;
  /** Called after a preset or model is chosen, so the host can move focus onward (e.g. to the composer). */
  onSelectionCommitted?: () => void;
}) {
  const [openSlot, setOpenSlot] = useState<ModelPresetSlot | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Partial<Record<ModelPresetSlot, HTMLDivElement | null>>>({});
  const tileButtonRefs = useRef<Partial<Record<ModelPresetSlot, HTMLButtonElement | null>>>({});
  const state = resolveModelPresetState({
    models,
    selectedModelId,
    selectedPresetSlot,
    globalDefaultModelId,
    presets,
  });
  const hasResolvedSelection = Boolean(
    state.liveSlot && state.tiles.find((tile) => tile.slot === state.liveSlot)?.model,
  );

  useEffect(() => {
    if (!openSlot) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpenSlot(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [openSlot]);

  useEffect(() => {
    if (disabled) setOpenSlot(null);
  }, [disabled]);

  const closeMenuAndRestoreFocus = useCallback((slot: ModelPresetSlot) => {
    setOpenSlot(null);
    tileButtonRefs.current[slot]?.focus?.();
  }, []);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Model presets"
      className="@container/presets w-full"
    >
      <div className={cx(DS.segmented.groupFull, "flex-col items-stretch @[28rem]/presets:flex-row @[28rem]/presets:items-center")}>
        {state.tiles.map((tile) => {
          const unavailable = !tile.model;
          const bodyDisabled = disabled || unavailable;
          const menuDisabled = disabled || state.availableModels.length === 0;
          const open = openSlot === tile.slot;
          const live = tile.isLive && (!allowUnselected || hasResolvedSelection);
          return (
            <div
              key={tile.slot}
              ref={(node) => {
                tileRefs.current[tile.slot] = node;
              }}
              className={cx(
                "relative min-w-0 flex-1 rounded-md transition-colors",
                live ? DS.segmented.selected : "text-text-muted",
                menuDisabled && "opacity-60",
              )}
            >
              <div className="flex items-stretch">
                <button
                  ref={(node) => {
                    tileButtonRefs.current[tile.slot] = node;
                  }}
                  type="button"
                  id={`${idPrefix}-${tile.slot}`}
                  aria-label={`${tile.label}: ${tile.model?.name ?? "no model selected"}`}
                  aria-pressed={live}
                  aria-haspopup={live && !menuDisabled ? "listbox" : undefined}
                  aria-expanded={live && !menuDisabled ? open : undefined}
                  title={live && !menuDisabled
                    ? `${tile.model?.name ?? "No model selected"} (click to change model)`
                    : tile.model?.name ?? "No model selected"}
                  disabled={bodyDisabled}
                  onClick={() => {
                    // The live tile doubles as its own menu trigger: a second click refines it.
                    if (live && !menuDisabled) {
                      setOpenSlot(open ? null : tile.slot);
                      return;
                    }
                    setOpenSlot(null);
                    onSelectPreset(tile.slot);
                    onSelectionCommitted?.();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && !menuDisabled) {
                      event.preventDefault();
                      setOpenSlot(tile.slot);
                    }
                  }}
                  className={cx(
                    "h-10 min-w-0 flex-1 truncate rounded-l-md pl-2.5 pr-1 text-left text-[13px] font-medium transition-colors enabled:hover:text-text-primary disabled:cursor-not-allowed md:h-8",
                    DS.focus,
                  )}
                >
                  {tile.model?.name ?? "None"}
                </button>
                <button
                  type="button"
                  aria-label={`Choose ${tile.label} model`}
                  aria-expanded={open}
                  aria-haspopup="listbox"
                  disabled={menuDisabled}
                  onClick={() => setOpenSlot(open ? null : tile.slot)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && !menuDisabled) {
                      event.preventDefault();
                      setOpenSlot(tile.slot);
                    }
                  }}
                  className={cx(
                    "relative flex w-9 shrink-0 items-center justify-center rounded-r-md text-text-faint before:absolute before:inset-y-2 before:left-0 before:border-l before:border-border-subtle transition-colors enabled:hover:bg-bg-hover/60 enabled:hover:text-text-primary disabled:cursor-not-allowed",
                    DS.focus,
                  )}
                >
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {open && !menuDisabled && (
                <PresetRefineMenu
                  tile={tile}
                  models={state.availableModels}
                  globalDefaultModelId={globalDefaultModelId}
                  tileRefs={tileRefs}
                  onSelect={(modelId) => {
                    setOpenSlot(null);
                    onSelectModel(tile.slot, modelId);
                    onSelectionCommitted?.();
                  }}
                  onClose={() => closeMenuAndRestoreFocus(tile.slot)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
