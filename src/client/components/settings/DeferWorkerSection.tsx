import type { AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { formatReasoningEffortLabel, getModelReasoningEfforts } from "../../reasoning-effort";
import {
  getContextTierLabel,
  modelSupportsLongContext,
  modelUsesDynamicSelection,
  type CopilotContextTier,
} from "../../../shared/copilot-context.js";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { SettingList, SettingRow } from "../../design/primitives";

export function DeferWorkerSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (draft: AppSettings) => void;
}) {
  const { data: models } = useModelsQuery();
  const availableModels = (models ?? [])
    .filter((model) => !model.policy || model.policy.state !== "disabled")
    .sort((a, b) => a.name.localeCompare(b.name));
  const settings = {
    reasoningEffort: "low",
    contextTier: "default" as CopilotContextTier,
    ...draft.deferWorker,
  };
  const selectedModel = availableModels.find((model) => model.id === settings.model);
  const selectedModelUsesDynamicSelection = modelUsesDynamicSelection(selectedModel);
  const supportsLongContext = modelSupportsLongContext(selectedModel);
  const efforts = getModelReasoningEfforts(models, settings.model);
  if (settings.reasoningEffort && !efforts.includes(settings.reasoningEffort)) {
    efforts.push(settings.reasoningEffort);
  }

  const update = (changes: Partial<NonNullable<AppSettings["deferWorker"]>>) => {
    setDraft({
      ...draft,
      deferWorker: {
        ...settings,
        ...changes,
      },
    });
  };

  return (
    <SettingsSection
      title="Deferred workers"
      description="Each check runs in a temporary session that is deleted afterwards."
    >
      <SettingList>
        <SettingRow label="Model" htmlFor="defer-worker-model" control={(
          <select
            id="defer-worker-model"
            value={settings.model ?? ""}
            onChange={(event) => {
              const model = event.target.value || undefined;
              const nextModel = availableModels.find((candidate) => candidate.id === model);
              const supportedEfforts = nextModel?.supportedReasoningEfforts ?? [];
              update({
                model,
                contextTier: modelUsesDynamicSelection(nextModel)
                  ? undefined
                  : modelSupportsLongContext(nextModel)
                  ? (settings.contextTier ?? "default")
                  : "default",
                reasoningEffort: modelUsesDynamicSelection(nextModel)
                  ? undefined
                  : settings.reasoningEffort
                  && !supportedEfforts.includes(settings.reasoningEffort)
                  ? supportedEfforts.includes("low") ? "low" : supportedEfforts[0]
                  : settings.reasoningEffort,
              });
            }}
            className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
          >
            <option value="">Automatic (economy model when available)</option>
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </select>
        )} />

        <SettingRow label="Context" htmlFor="defer-worker-context" control={(
          <select
            id="defer-worker-context"
            value={selectedModelUsesDynamicSelection ? "" : settings.contextTier ?? "default"}
            onChange={(event) => update({ contextTier: event.target.value as CopilotContextTier })}
            disabled={selectedModelUsesDynamicSelection}
            className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
          >
            {selectedModelUsesDynamicSelection && <option value="">Selected dynamically</option>}
            <option value="default">
              {getContextTierLabel(selectedModel, "default") ?? "Standard context"}
            </option>
            {supportsLongContext && (
              <option value="long_context">
                {getContextTierLabel(selectedModel, "long_context") ?? "Long context"}
              </option>
            )}
          </select>
        )} />

        <SettingRow label="Reasoning effort" htmlFor="defer-worker-effort" control={(
          <select
            id="defer-worker-effort"
            value={selectedModelUsesDynamicSelection ? "" : settings.reasoningEffort ?? ""}
            onChange={(event) => update({ reasoningEffort: event.target.value || undefined })}
            disabled={selectedModelUsesDynamicSelection}
            className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
          >
            <option value="">{selectedModelUsesDynamicSelection ? "Selected dynamically" : "Model default"}</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {formatReasoningEffortLabel(effort) ?? effort}
              </option>
            ))}
          </select>
        )} />
      </SettingList>
    </SettingsSection>
  );
}
