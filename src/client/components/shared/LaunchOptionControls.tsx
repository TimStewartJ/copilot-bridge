import type { ModelInfo } from "../../api";
import type { LaunchOption } from "../../lib/new-session-launch";
import { SegmentedControl, Select } from "../../design/primitives";

export function formatModelMultiplier(multiplier: unknown): string {
  return typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier !== 1
    ? ` (${multiplier}x)`
    : "";
}

/** Launch choices keep the inherited placeholder and explicit reselection semantics. */
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
    <SegmentedControl
      ariaLabel={ariaLabel}
      options={options}
      value={selectedValue}
      onChange={onChange}
      onReselect={onChange}
      disabled={disabled}
      fullWidth
    />
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
    <Select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
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
    </Select>
  );
}
