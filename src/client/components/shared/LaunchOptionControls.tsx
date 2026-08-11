import type { ModelInfo } from "../../api";
import type { LaunchOption } from "../../lib/new-session-launch";

export function formatModelMultiplier(multiplier: unknown): string {
  return typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier !== 1
    ? ` (${multiplier}x)`
    : "";
}

/**
 * Segmented button row used for the launch options (effort, context tier, run
 * mode) on both the new-chat screen and the change-model dialog. An option with
 * a `null` value is an inert placeholder that stays highlighted when there is
 * nothing to choose.
 */
export function LaunchOptionRow<T extends string>({
  ariaLabel,
  options,
  selectedValue,
  onChange,
  disabled = false,
}: {
  ariaLabel: string;
  options: readonly LaunchOption<T>[];
  selectedValue?: T;
  onChange: (value: T | null) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="grid w-full gap-2"
      role="group"
      aria-label={ariaLabel}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const selected = option.value === null
          ? selectedValue === undefined
          : selectedValue === option.value;
        return (
          <button
            key={option.value === null ? "__inherited_default__" : option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled || option.value === null}
            onClick={() => {
              if (option.value !== null) onChange(option.value);
            }}
            className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              selected
                ? "border-accent bg-accent/10 text-accent"
                : "border-border bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            } ${disabled ? "disabled:opacity-60" : "disabled:cursor-default disabled:opacity-100"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Model picker shared by the new-chat screen and the change-model dialog.
 * Loading/error presentation stays with the callers because they differ
 * intentionally (inline notice vs. retry box).
 */
export function LaunchModelSelect({
  id,
  ariaLabel,
  models,
  value,
  placeholderLabel,
  placeholderDisabled = false,
  unlistedModelId,
  disabled = false,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  models: readonly ModelInfo[];
  value: string;
  placeholderLabel: string;
  placeholderDisabled?: boolean;
  unlistedModelId?: string;
  disabled?: boolean;
  onChange: (modelId: string) => void;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="w-full appearance-none rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      <option value="" disabled={placeholderDisabled}>
        {placeholderLabel}
      </option>
      {unlistedModelId && <option value={unlistedModelId}>{unlistedModelId}</option>}
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name}{formatModelMultiplier(model.billing?.multiplier)}
        </option>
      ))}
    </select>
  );
}
