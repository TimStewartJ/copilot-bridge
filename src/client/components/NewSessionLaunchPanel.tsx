import type { ModelInfo, ModelPresets, TaskAgentDefinitionSummary } from "../api";
import type {
  LaunchOption,
} from "../lib/new-session-launch";
import { LaunchOptionRow } from "./shared/LaunchOptionControls";
import ModelPresetPicker from "./shared/ModelPresetPicker";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import type { SendMode } from "../../shared/send-mode.js";

interface NewSessionLaunchPanelProps {
  models: readonly ModelInfo[];
  modelsLoading: boolean;
  modelsError?: string;
  defaultModelId?: string;
  presets?: ModelPresets;
  selectedModelId: string;
  selectedPresetSlot?: ModelPresetSlot;
  reasoningEffortOptions: readonly LaunchOption<string>[];
  selectedReasoningEffort?: string;
  contextOptions: readonly LaunchOption<CopilotContextTier>[];
  selectedContextTier?: CopilotContextTier;
  mode: SendMode;
  agentDefinitions?: readonly TaskAgentDefinitionSummary[];
  agentDefinitionsLoading?: boolean;
  selectedAgentName?: string;
  onPresetChange: (slot: ModelPresetSlot) => void;
  onModelChange: (slot: ModelPresetSlot, modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort?: string) => void;
  onContextTierChange: (contextTier?: CopilotContextTier) => void;
  onModeChange: (mode: SendMode) => void;
  onAgentChange?: (agentName?: string) => void;
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
  presets,
  selectedModelId,
  selectedPresetSlot,
  reasoningEffortOptions,
  selectedReasoningEffort,
  contextOptions,
  selectedContextTier,
  mode,
  agentDefinitions,
  agentDefinitionsLoading,
  selectedAgentName,
  onPresetChange,
  onModelChange,
  onReasoningEffortChange,
  onContextTierChange,
  onModeChange,
  onAgentChange,
}: NewSessionLaunchPanelProps) {
  const availableModels = models.filter((model) => model.policy?.state !== "disabled");
  const hasResolvedModelSelection = Boolean(
    selectedModelId && availableModels.some((model) => model.id === selectedModelId),
  );

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-4 md:items-center md:py-8">
      <div className="w-full max-w-lg px-1 py-5">
        <div className="mb-5">
          <h2 className="text-base font-semibold text-text-primary">Start a new chat</h2>
          <p className="mt-1 text-sm text-text-muted">
            Model, effort, context, and agent choices apply when this chat starts.
          </p>
        </div>

        <div className="space-y-4">
          {agentDefinitions !== undefined && (
            <div className="space-y-1.5">
              <label htmlFor="new-session-agent" className="text-xs font-medium text-text-muted">
                Agent definition
              </label>
              <select
                id="new-session-agent"
                value={selectedAgentName ?? ""}
                disabled={agentDefinitionsLoading}
                onChange={(event) => onAgentChange?.(event.target.value || undefined)}
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none disabled:opacity-60"
              >
                <option value="">Default Copilot agent</option>
                {agentDefinitions
                  .filter((definition) => definition.userInvocable)
                  .map((definition) => (
                    <option key={definition.name} value={definition.name}>
                      {definition.displayName ?? definition.name}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-text-faint">
                {agentDefinitionsLoading
                  ? "Loading attached agents..."
                  : agentDefinitions.length === 0
                    ? "No agent definitions are attached to this task."
                    : "Blank starts with the default agent. Selecting one makes the new chat run as that specialist."}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            {modelsLoading ? (
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-faint">
                Loading models...
              </div>
            ) : (
              <ModelPresetPicker
                idPrefix="new-session"
                models={availableModels}
                selectedModelId={selectedModelId}
                selectedPresetSlot={selectedPresetSlot}
                globalDefaultModelId={defaultModelId}
                presets={presets}
                allowUnselected
                disabled={Boolean(modelsError)}
                onSelectPreset={onPresetChange}
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
