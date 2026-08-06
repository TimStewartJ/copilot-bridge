import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelFamilyDefaults, ModelInfo } from "../../api";
import type { ModelFamily } from "../../../shared/model-families.js";
import {
  resolveModelFamilyState,
  type ModelFamilyPickerState,
  type ModelFamilyTile,
} from "../../lib/model-family-defaults";
import { formatModelMultiplier } from "./LaunchOptionControls";

function FamilyRefineMenu({
  tile,
  models,
  selectedModelId,
  globalDefaultModelId,
  onSelect,
  onClose,
}: {
  tile: ModelFamilyTile;
  models: readonly ModelInfo[];
  selectedModelId?: string;
  globalDefaultModelId?: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

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
      className="absolute left-0 top-full z-30 mt-1 max-h-64 min-w-52 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1 shadow-xl"
    >
      {models.map((model, index) => {
        const selected = model.id === selectedModelId;
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

/**
 * Family-first model picker. Clicking a tile body switches to that family's
 * remembered model in one click; the caret opens a menu to refine within the
 * family. Families with no selectable models render disabled.
 */
export default function ModelFamilyPicker({
  models,
  selectedModelId,
  globalDefaultModelId,
  familyDefaults,
  disabled = false,
  idPrefix,
  onSelectFamily,
  onSelectModel,
}: {
  models: readonly ModelInfo[];
  selectedModelId: string;
  globalDefaultModelId?: string;
  familyDefaults?: ModelFamilyDefaults;
  disabled?: boolean;
  idPrefix: string;
  onSelectFamily: (family: ModelFamily) => void;
  onSelectModel: (modelId: string) => void;
}) {
  const [openFamily, setOpenFamily] = useState<ModelFamily | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const state: ModelFamilyPickerState = resolveModelFamilyState({
    models,
    selectedModelId,
    globalDefaultModelId,
    familyDefaults,
  });

  useEffect(() => {
    if (!openFamily) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpenFamily(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [openFamily]);

  useEffect(() => {
    if (disabled) setOpenFamily(null);
  }, [disabled]);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Model family"
      // Horizontal scroll keeps full model names readable at phone widths.
      className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1"
    >
      {state.tiles.map((tile) => {
        const familyModels = state.modelsByFamily[tile.family];
        const unavailable = !tile.model;
        const tileDisabled = disabled || unavailable;
        const open = openFamily === tile.family;
        const live = tile.isLive && !unavailable;
        return (
          <div
            key={tile.family}
            className={`relative min-w-28 flex-1 shrink-0 snap-start rounded-md border transition-colors ${
              live ? "border-accent bg-accent/10" : "border-border bg-bg-surface"
            } ${tileDisabled ? "opacity-60" : ""}`}
          >
            <div className="flex items-stretch">
              <button
                type="button"
                id={`${idPrefix}-family-${tile.family}`}
                // The family name is dropped visually to keep the tile to one
                // line, so it is carried here for assistive tech instead.
                aria-label={`${tile.label}: ${tile.model?.name ?? "no models available"}`}
                aria-pressed={live}
                disabled={tileDisabled}
                onClick={() => {
                  setOpenFamily(null);
                  onSelectFamily(tile.family);
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
                disabled={tileDisabled}
                onClick={() => setOpenFamily(open ? null : tile.family)}
                className="flex w-6 shrink-0 items-center justify-center rounded-r-md border-l border-border text-text-faint enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:cursor-not-allowed"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            {open && !tileDisabled && (
              <FamilyRefineMenu
                tile={tile}
                models={familyModels}
                selectedModelId={tile.model?.id}
                globalDefaultModelId={globalDefaultModelId}
                onSelect={(modelId) => {
                  setOpenFamily(null);
                  onSelectModel(modelId);
                }}
                onClose={() => setOpenFamily(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
