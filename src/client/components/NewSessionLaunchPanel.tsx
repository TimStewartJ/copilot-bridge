import type { ModelInfo } from "../api";
import type {
  LaunchOption,
} from "../lib/new-session-launch";
import { LaunchModelSelect, LaunchOptionRow } from "./shared/LaunchOptionControls";
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

const MODE_OPTIONS: LaunchOption<SendMode>[] = [
  { value: "interactive", label: "Interactive" },
  { value: "autopilot", label: "Autopilot" },
];

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
            <LaunchModelSelect
              id="new-session-model"
              ariaLabel="Model for new session"
              models={availableModels}
              value={selectedModelId}
              placeholderLabel={modelsLoading ? "Loading models..." : defaultLabel}
              disabled={modelsLoading || Boolean(modelsError)}
              onChange={onModelChange}
            />
            {modelsError && (
              <p className="text-xs text-error" role="alert">
                Models could not be loaded. The default model will be used.
              </p>
            )}
          </div>

          <LaunchOptionRow
            ariaLabel="Effort for new session"
            options={reasoningEffortOptions}
            selectedValue={selectedReasoningEffort}
            onChange={onReasoningEffortChange}
          />

          <LaunchOptionRow
            ariaLabel="Context for new session"
            options={contextOptions}
            selectedValue={selectedContextTier}
            onChange={onContextTierChange}
          />

          <div className="space-y-1.5">
            <LaunchOptionRow
              ariaLabel="Run mode for new session"
              options={MODE_OPTIONS}
              selectedValue={mode}
              onChange={onModeChange}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
