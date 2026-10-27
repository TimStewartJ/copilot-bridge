import type { ModelInfo, ModelPresets, TaskAgentDefinitionSummary } from "../api";
import type {
  LaunchOption,
} from "../lib/new-session-launch";
import { LaunchOptionRow } from "./shared/LaunchOptionControls";
import ModelPresetPicker from "./shared/ModelPresetPicker";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import type { SendMode } from "../../shared/send-mode.js";
import {
  PROMPT_PROFILES,
  type PromptProfileId,
} from "../../shared/prompt-profiles.js";
import { DS, cx } from "../design/tokens";
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
  selectedPromptProfile: PromptProfileId;
  mode: SendMode;
  agentDefinitions?: readonly TaskAgentDefinitionSummary[];
  agentDefinitionsLoading?: boolean;
  selectedAgentName?: string;
  onPresetChange: (slot: ModelPresetSlot) => void;
  onModelChange: (slot: ModelPresetSlot, modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort?: string) => void;
  onContextTierChange: (contextTier?: CopilotContextTier) => void;
  onPromptProfileChange: (promptProfile: PromptProfileId) => void;
  onModeChange: (mode: SendMode) => void;
  onAgentChange?: (agentName?: string) => void;
  /** Called after a preset or model is chosen so the composer can take focus. */
  onModelSelectionCommitted?: () => void;
  /** Set when this chat's model, effort or context differ from its tier's. */
  tierChange?: { tierLabel: string; onReset: () => void; onSave: () => void };
}

const PROFILE_OPTIONS: LaunchOption<PromptProfileId>[] = PROMPT_PROFILES.map((profile) => ({
  value: profile.id,
  label: profile.label,
}));

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
  selectedPromptProfile,
  mode,
  agentDefinitions,
  agentDefinitionsLoading,
  selectedAgentName,
  onPresetChange,
  onModelChange,
  onReasoningEffortChange,
  onContextTierChange,
  onPromptProfileChange,
  onModeChange,
  onAgentChange,
  onModelSelectionCommitted,
  tierChange,
}: NewSessionLaunchPanelProps) {
  const availableModels = models.filter((model) => model.policy?.state !== "disabled");

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-4 md:items-center md:py-8">
      <div className="w-full max-w-xl px-1 py-5">
        <div className="mb-6">
          <h2 className={DS.text.title}>Start a new chat</h2>
        </div>

        <div className="space-y-4">
          {agentDefinitions !== undefined && (
            <FormRow
              label="Agent"
              htmlFor="new-session-agent"
              hideLabel
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
                showSlotLabels
                models={availableModels}
                selectedModelId={selectedModelId}
                selectedPresetSlot={selectedPresetSlot}
                globalDefaultModelId={defaultModelId}
                presets={presets}
                allowUnselected
                disabled={Boolean(modelsError)}
                onSelectPreset={onPresetChange}
                onSelectModel={onModelChange}
                onSelectionCommitted={onModelSelectionCommitted}
              />
            )}
            {modelsError && (
              <p className="text-xs text-error" role="alert">
                Models could not be loaded.
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

          {tierChange && (
            <div className={cx(DS.text.meta, "-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1")}>
              <span>This chat only</span>
              <button type="button" className={cx(DS.focus, "rounded hover:text-text-primary hover:underline")} onClick={tierChange.onReset}>Reset</button>
              <button type="button" className={cx(DS.focus, "rounded hover:text-text-primary hover:underline")} onClick={tierChange.onSave}>Save as {tierChange.tierLabel}</button>
            </div>
          )}

          <FormRow label="Profile" hideLabel>
            <LaunchOptionRow
              ariaLabel="Profile for new session"
              options={PROFILE_OPTIONS}
              selectedValue={selectedPromptProfile}
              onChange={(value) => {
                if (value) onPromptProfileChange(value);
              }}
            />
          </FormRow>

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
