import type { AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { formatReasoningEffortLabel } from "../../reasoning-effort";
import {
  BRIDGE_DEFAULT_SUBAGENTS,
  BUILT_IN_SUBAGENTS,
  SUBAGENT_INHERIT_MODEL,
  SUBAGENT_RUNTIME_DEFAULT,
  isConcreteSubagentModel,
  type SubagentAgentSetting,
  type SubagentSettings,
} from "../../../shared/subagent-settings.js";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { SettingList, SettingRow } from "../../design/primitives";

const SOURCE_BRIDGE = "bridge";
const SOURCE_CLI = "cli";

function withoutEmpty(settings: SubagentSettings): SubagentSettings | undefined {
  const hasAgents = Object.keys(settings.agents ?? {}).length > 0;
  if (settings.source !== "cli" && !hasAgents) return undefined;
  return {
    ...(settings.source === "cli" ? { source: "cli" as const } : {}),
    ...(hasAgents ? { agents: settings.agents } : {}),
  };
}

export function SubagentModelsSection({
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
  const modelLabel = (model: string) => {
    if (model === SUBAGENT_INHERIT_MODEL) return "Inherit main session model";
    if (model === SUBAGENT_RUNTIME_DEFAULT) return "Runtime default";
    return availableModels.find((candidate) => candidate.id === model)?.name ?? model;
  };
  const effortLabel = (effort: string) => formatReasoningEffortLabel(effort) ?? effort;
  const settings = draft.subagents ?? {};
  const usesCli = settings.source === "cli";

  const setOverride = (name: string, override: SubagentAgentSetting) => {
    const agents = { ...settings.agents };
    if (override.model || override.effortLevel) agents[name] = override;
    else delete agents[name];
    setDraft({ ...draft, subagents: withoutEmpty({ ...settings, agents }) });
  };

  return (
    <SettingsSection
      title="Sub-agent models"
      description="Bridge applies its own sub-agent defaults to every session. Override any agent below."
    >
      <SettingList>
        <SettingRow
          label="Source"
          htmlFor="subagent-models-source"
          hint={usesCli
            ? "Uses the subagents settings in the Copilot CLI's settings.json."
            : "Bridge defaults plus your overrides replace the Copilot CLI's sub-agent settings."}
          control={(
            <select
              id="subagent-models-source"
              value={usesCli ? SOURCE_CLI : SOURCE_BRIDGE}
              onChange={(event) => setDraft({
                ...draft,
                subagents: withoutEmpty({
                  ...settings,
                  source: event.target.value === SOURCE_CLI ? "cli" : undefined,
                }),
              })}
              className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
            >
              <option value={SOURCE_BRIDGE}>Bridge</option>
              <option value={SOURCE_CLI}>Copilot CLI settings</option>
            </select>
          )}
        />
        {!usesCli && BUILT_IN_SUBAGENTS.map((agent) => {
          const id = `subagent-model-${agent.name}`;
          const override = settings.agents?.[agent.name] ?? {};
          const bridgeDefault = BRIDGE_DEFAULT_SUBAGENTS[agent.name];
          const effectiveModel = override.model ?? bridgeDefault?.model;
          const namedModel = isConcreteSubagentModel(effectiveModel)
            ? availableModels.find((model) => model.id === effectiveModel)
            : undefined;
          const efforts = namedModel?.supportedReasoningEfforts ?? [];
          const effortSelectable = efforts.length > 0;
          // The default effort belongs to the default model, so a model override drops it.
          const defaultEffort = override.model === undefined || override.model === bridgeDefault?.model
            ? bridgeDefault?.effortLevel
            : undefined;
          const unknownModel = override.model
            && isConcreteSubagentModel(override.model)
            && !availableModels.some((model) => model.id === override.model);
          return (
            <SettingRow key={agent.name} label={agent.name} hint={agent.description} htmlFor={id} control={(
              <>
                <select
                  id={id}
                  value={override.model ?? ""}
                  onChange={(event) => {
                    const model = event.target.value || undefined;
                    const nextModelId = model ?? bridgeDefault?.model;
                    const nextModel = availableModels.find((candidate) => candidate.id === nextModelId);
                    const keepEffort = override.effortLevel === SUBAGENT_RUNTIME_DEFAULT
                      || (override.effortLevel !== undefined
                        && nextModel?.supportedReasoningEfforts?.includes(override.effortLevel));
                    setOverride(agent.name, {
                      ...(model ? { model } : {}),
                      ...(keepEffort ? { effortLevel: override.effortLevel } : {}),
                    });
                  }}
                  className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
                >
                  <option value="">
                    {bridgeDefault ? `Bridge default (${modelLabel(bridgeDefault.model)})` : "Bridge default (runtime)"}
                  </option>
                  <option value={SUBAGENT_INHERIT_MODEL}>Inherit main session model</option>
                  <option value={SUBAGENT_RUNTIME_DEFAULT}>Runtime default</option>
                  {unknownModel && <option value={override.model}>{override.model}</option>}
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </select>
                <select
                  aria-label={`${agent.name} reasoning effort`}
                  title={effortSelectable ? undefined : "Effort can be set only when a specific model is chosen"}
                  value={effortSelectable ? override.effortLevel ?? "" : ""}
                  disabled={!effortSelectable}
                  onChange={(event) => setOverride(agent.name, {
                    ...(override.model ? { model: override.model } : {}),
                    ...(event.target.value ? { effortLevel: event.target.value } : {}),
                  })}
                  className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.compactField)}
                >
                  <option value="">
                    {!effortSelectable
                      ? "Follows model"
                      : defaultEffort && efforts.includes(defaultEffort)
                      ? `Bridge default (${effortLabel(defaultEffort)})`
                      : "Bridge default (model default)"}
                  </option>
                  {effortSelectable && <option value={SUBAGENT_RUNTIME_DEFAULT}>Model default</option>}
                  {efforts.map((effort) => (
                    <option key={effort} value={effort}>{effortLabel(effort)}</option>
                  ))}
                </select>
              </>
            )} />
          );
        })}
      </SettingList>
    </SettingsSection>
  );
}
