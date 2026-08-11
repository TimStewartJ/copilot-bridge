import type { ModelInfo } from "../api";
import type {
  LaunchOption,
} from "../lib/new-session-launch";
import { LaunchOptionRow } from "./shared/LaunchOptionControls";
import ModelFamilyPicker from "./shared/ModelFamilyPicker";
import type { ModelFamily } from "../../shared/model-families.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import type { SendMode } from "../../shared/send-mode.js";

interface NewSessionLaunchPanelProps {
  models: readonly ModelInfo[];
  modelsLoading: boolean;
  modelsError?: string;
  defaultModelId?: string;
  selectedModelId: string;
  selectedModelFamily?: ModelFamily;
  reasoningEffortOptions: readonly LaunchOption<string>[];
  selectedReasoningEffort?: string;
  contextOptions: readonly LaunchOption<CopilotContextTier>[];
  selectedContextTier?: CopilotContextTier;
  mode: SendMode;
  onModelFamilyChange: (family: ModelFamily) => void;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort?: string) => void;
  onContextTierChange: (contextTier?: CopilotContextTier) => void;
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
  selectedModelFamily,
  reasoningEffortOptions,
  selectedReasoningEffort,
  contextOptions,
  selectedContextTier,
  mode,
  onModelFamilyChange,
  onModelChange,
  onReasoningEffortChange,
  onContextTierChange,
  onModeChange,
}: NewSessionLaunchPanelProps) {
  const availableModels = models.filter((model) => model.policy?.state !== "disabled");
  const hasResolvedModelSelection = Boolean(
    selectedModelId && availableModels.some((model) => model.id === selectedModelId),
  );

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
            {modelsLoading ? (
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-faint">
                Loading models...
              </div>
            ) : (
              <ModelFamilyPicker
                idPrefix="new-session"
                models={availableModels}
                selectedModelId={selectedModelId}
                selectedFamily={selectedModelFamily}
                globalDefaultModelId={defaultModelId}
                allowUnselected
                disabled={Boolean(modelsError)}
                onSelectFamily={onModelFamilyChange}
                onSelectModel={onModelChange}
              />
            )}
            {modelsError && (
              <p className="text-xs text-error" role="alert">
                Models could not be loaded. The server will resolve the launch model when this chat starts.
              </p>
            )}
            {!modelsLoading && !modelsError && !hasResolvedModelSelection && (
              <p className="text-xs text-text-faint">
                No concrete default model is available. Choose one to override the server selection.
              </p>
            )}
          </div>

          {reasoningEffortOptions.length > 0 && (
            <div className="space-y-1.5">
              <LaunchOptionRow
                ariaLabel="Effort for new session"
                options={reasoningEffortOptions}
                selectedValue={selectedReasoningEffort}
                onChange={(value) => {
                  if (value) onReasoningEffortChange(value);
                }}
              />
              {!selectedReasoningEffort && (
                <p className="text-xs text-text-faint">
                  The SDK does not report this model&apos;s default effort. Choose a level to override it.
                </p>
              )}
            </div>
          )}

          {contextOptions.length > 0 && (
            <LaunchOptionRow
              ariaLabel="Context for new session"
              options={contextOptions}
              selectedValue={selectedContextTier}
              onChange={(value) => {
                if (value) onContextTierChange(value);
              }}
            />
          )}

          <div className="space-y-1.5">
            <LaunchOptionRow
              ariaLabel="Run mode for new session"
              options={MODE_OPTIONS}
              selectedValue={mode}
              onChange={(value) => {
                if (value) onModeChange(value);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
