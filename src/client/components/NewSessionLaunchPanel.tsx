import type { ModelInfo } from "../api";
import type {
  LaunchOption,
} from "../lib/new-session-launch";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import type { SendMode } from "../../shared/send-mode.js";

interface NewSessionLaunchPanelProps {
  models: readonly ModelInfo[];
  modelsLoading: boolean;
  modelsError?: string;
  defaultModelId?: string;
  selectedModelId: string;
  reasoningEffortOptions: readonly LaunchOption<string>[];
  selectedReasoningEffort?: string;
  contextOptions: readonly LaunchOption<CopilotContextTier>[];
  selectedContextTier?: CopilotContextTier;
  mode: SendMode;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort: string) => void;
  onContextTierChange: (contextTier: CopilotContextTier) => void;
  onModeChange: (mode: SendMode) => void;
}

function LaunchButtonRow<T extends string>({
  label,
  options,
  selectedValue,
  onChange,
}: {
  label: string;
  options: readonly LaunchOption<T>[];
  selectedValue?: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="grid w-full gap-2"
      role="group"
      aria-label={`${label} for new session`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
        {options.map((option) => {
          const selected = option.value === null
            ? selectedValue === undefined
            : selectedValue === option.value;
          return (
            <button
              key={option.value ?? "default"}
              type="button"
              aria-pressed={selected}
              disabled={option.value === null}
              onClick={() => {
                if (option.value !== null) onChange(option.value);
              }}
              className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              } disabled:cursor-default disabled:opacity-100`}
            >
              {option.label}
            </button>
          );
        })}
    </div>
  );
}

export default function NewSessionLaunchPanel({
  models,
  modelsLoading,
  modelsError,
  defaultModelId,
  selectedModelId,
  reasoningEffortOptions,
  selectedReasoningEffort,
  contextOptions,
  selectedContextTier,
  mode,
  onModelChange,
  onReasoningEffortChange,
  onContextTierChange,
  onModeChange,
}: NewSessionLaunchPanelProps) {
  const availableModels = models
    .filter((model) => model.policy?.state !== "disabled")
    .sort((left, right) => left.name.localeCompare(right.name));
  const defaultModel = availableModels.find((model) => model.id === defaultModelId);
  const defaultLabel = defaultModel
    ? `Default - ${defaultModel.name}`
    : "Default model";

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg px-1 py-5">
        <div className="mb-5">
          <h2 className="text-base font-semibold text-text-primary">Start a new chat</h2>
          <p className="mt-1 text-sm text-text-muted">
            Choose how this session should start. These choices only apply to this chat.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="new-session-model" className="sr-only">
              Model
            </label>
            <select
              id="new-session-model"
              aria-label="Model for new session"
              value={selectedModelId}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={modelsLoading || Boolean(modelsError)}
              className="w-full appearance-none rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">{modelsLoading ? "Loading models..." : defaultLabel}</option>
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            {modelsError && (
              <p className="text-xs text-error" role="alert">
                Models could not be loaded. The default model will be used.
              </p>
            )}
          </div>

          <LaunchButtonRow
            label="Effort"
            options={reasoningEffortOptions}
            selectedValue={selectedReasoningEffort}
            onChange={onReasoningEffortChange}
          />

          <LaunchButtonRow
            label="Context"
            options={contextOptions}
            selectedValue={selectedContextTier}
            onChange={onContextTierChange}
          />

          <div className="space-y-1.5">
            <div
              className="grid grid-cols-2 gap-2"
              role="group"
              aria-label="Run mode for new session"
            >
              {(["interactive", "autopilot"] as const).map((candidate) => {
                const selected = mode === candidate;
                const label = candidate === "interactive" ? "Interactive" : "Autopilot";
                return (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onModeChange(candidate)}
                    className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      selected
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
