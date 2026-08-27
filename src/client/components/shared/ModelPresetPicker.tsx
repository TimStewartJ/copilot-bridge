import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
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

  useEffect(() => {
    firstItemRef.current?.focus?.();
  }, []);

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={`${tile.label} models`}
      className={`z-50 min-w-52 overflow-y-auto overscroll-contain rounded-md border border-border bg-bg-elevated p-1 shadow-xl ${
        placement ? "fixed" : "absolute left-0 top-full mt-1 max-h-64"
      }`}
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
            ref={index === 0 ? firstItemRef : undefined}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(model.id)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
              selected
                ? "bg-accent/10 font-semibold text-text-primary"
                : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            }`}
          >
            <Check className={`h-3 w-3 shrink-0 ${selected ? "text-accent" : "opacity-0"}`} />
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
}) {
  const [openSlot, setOpenSlot] = useState<ModelPresetSlot | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Partial<Record<ModelPresetSlot, HTMLDivElement | null>>>({});
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

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Model presets"
      className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1"
    >
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
            className={`relative min-w-32 flex-1 shrink-0 snap-start rounded-md border transition-colors ${
              live ? "border-accent bg-accent/10" : "border-border bg-bg-surface"
            } ${menuDisabled ? "opacity-60" : ""}`}
          >
            <div className="flex items-stretch">
              <button
                type="button"
                id={`${idPrefix}-${tile.slot}`}
                aria-label={`${tile.label}: ${tile.model?.name ?? "no model selected"}`}
                aria-pressed={live}
                disabled={bodyDisabled}
                onClick={() => {
                  setOpenSlot(null);
                  onSelectPreset(tile.slot);
                }}
                className={`min-w-0 flex-1 truncate rounded-l-md px-2.5 py-1.5 text-left text-sm enabled:hover:bg-bg-hover/40 disabled:cursor-not-allowed ${
                  live ? "font-semibold text-text-primary" : "text-text-secondary"
                }`}
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
                className="flex w-6 shrink-0 items-center justify-center rounded-r-md border-l border-border text-text-faint enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:cursor-not-allowed"
              >
                <ChevronDown className="h-3.5 w-3.5" />
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
                }}
                onClose={() => setOpenSlot(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
