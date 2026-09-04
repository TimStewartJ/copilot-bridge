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
      title="Deferred Work"
      description="Run defers in temporary sessions instead of reloading the parent conversation. Temporary sessions are deleted after each check."
    >
      <div className="grid gap-4 rounded-md border border-border bg-bg-elevated p-4 md:grid-cols-3">
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          <span>Model</span>
          <select
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
            className="w-full appearance-none rounded-md border border-border bg-bg-surface px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Automatic (economy model when available)</option>
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs font-medium text-text-secondary">
          <span>Context</span>
          <select
            value={selectedModelUsesDynamicSelection ? "" : settings.contextTier ?? "default"}
            onChange={(event) => update({ contextTier: event.target.value as CopilotContextTier })}
            disabled={selectedModelUsesDynamicSelection}
            className="w-full appearance-none rounded-md border border-border bg-bg-surface px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
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
        </label>

        <label className="space-y-1 text-xs font-medium text-text-secondary">
          <span>Reasoning effort</span>
          <select
            value={selectedModelUsesDynamicSelection ? "" : settings.reasoningEffort ?? ""}
            onChange={(event) => update({ reasoningEffort: event.target.value || undefined })}
            disabled={selectedModelUsesDynamicSelection}
            className="w-full appearance-none rounded-md border border-border bg-bg-surface px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{selectedModelUsesDynamicSelection ? "Selected dynamically" : "Model default"}</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {formatReasoningEffortLabel(effort) ?? effort}
              </option>
            ))}
          </select>
        </label>
      </div>
    </SettingsSection>
  );
}
