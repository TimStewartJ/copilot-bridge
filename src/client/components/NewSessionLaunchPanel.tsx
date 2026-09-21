import type { ModelInfo, ModelPresets, TaskAgentDefinitionSummary } from "../api";
import type {
  LaunchOption,
} from "../lib/new-session-launch";
import { LaunchOptionRow } from "./shared/LaunchOptionControls";
import ModelPresetPicker from "./shared/ModelPresetPicker";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import type { SendMode } from "../../shared/send-mode.js";
import { DS } from "../design/tokens";
import { FormRow, Select } from "../design/primitives";

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
      <div className="w-full max-w-xl px-1 py-5">
        <div className="mb-6">
          <h2 className={DS.text.title}>Start a new chat</h2>
          <p className={`mt-1 ${DS.text.prose}`}>
            These choices apply when the chat starts.
          </p>
        </div>

        <div className="space-y-4">
          {agentDefinitions !== undefined && (
            <FormRow
              label="Agent"
              htmlFor="new-session-agent"
              hideLabel
              help={agentDefinitionsLoading
                ? "Loading attached agents..."
                : agentDefinitions.length === 0
                  ? "No agent definitions are attached to this task."
                  : "Blank starts with the default agent. Selecting one makes the new chat run as that specialist."}
            >
              <Select
                id="new-session-agent"
                value={selectedAgentName ?? ""}
                disabled={agentDefinitionsLoading}
                onChange={(event) => onAgentChange?.(event.target.value || undefined)}
              >
                <option value="">Default Copilot agent</option>
                {agentDefinitions
                  .filter((definition) => definition.userInvocable)
                  .map((definition) => (
                    <option key={definition.name} value={definition.name}>
                      {definition.displayName ?? definition.name}
                    </option>
                  ))}
              </Select>
            </FormRow>
          )}
          <FormRow label="Model" hideLabel>
            {modelsLoading ? (
              <div className={`flex h-10 items-center text-[13px] md:h-9 ${DS.motion.live}`} role="status">
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
              <p className={DS.field.help}>
                No concrete default model is available. Choose one to override the server selection.
              </p>
            )}
          </FormRow>

          {reasoningEffortOptions.length > 0 && (
            <FormRow label="Effort" hideLabel>
              <LaunchOptionRow
                ariaLabel="Effort for new session"
                options={reasoningEffortOptions}
                selectedValue={selectedReasoningEffort}
                onChange={(value) => {
                  if (value) onReasoningEffortChange(value);
                }}
              />
              {!selectedReasoningEffort && (
                <p className={DS.field.help}>
                  The SDK does not report this model&apos;s default effort. Choose a level to override it.
                </p>
              )}
            </FormRow>
          )}

          {contextOptions.length > 0 && (
            <FormRow label="Context" hideLabel>
              <LaunchOptionRow
                ariaLabel="Context for new session"
                options={contextOptions}
                selectedValue={selectedContextTier}
                onChange={(value) => {
                  if (value) onContextTierChange(value);
                }}
              />
            </FormRow>
          )}

          <FormRow label="Mode" hideLabel>
            <LaunchOptionRow
              ariaLabel="Run mode for new session"
              options={MODE_OPTIONS}
              selectedValue={mode}
              onChange={(value) => {
                if (value) onModeChange(value);
              }}
            />
          </FormRow>
        </div>
      </div>
    </div>
  );
}
