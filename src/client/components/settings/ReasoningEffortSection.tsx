import type { AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { formatReasoningEffortLabel, getModelReasoningEfforts } from "../../reasoning-effort";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { SettingList, SettingRow } from "../../design/primitives";

export function ReasoningEffortSection({
  draft,
  setDraft,
  embedded = false,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
  embedded?: boolean;
}) {
  const { data: models } = useModelsQuery();

  const currentModel = draft.model ?? "";
  const currentEffort = draft.reasoningEffort ?? "";

  const efforts = getModelReasoningEfforts(models, currentModel || undefined);
  const savedEffortUnavailable = Boolean(currentEffort) && !efforts.includes(currentEffort);
  // Keep a previously-saved effort visible even if the current model no longer
  // advertises it, so switching models never silently drops the user's choice.
  if (currentEffort && !efforts.includes(currentEffort)) efforts.push(currentEffort);

  const hint = savedEffortUnavailable
    ? "This saved effort isn't offered for the current model. It is kept until you choose another."
    : efforts.length === 0
      ? "This model has no reasoning levels to choose from."
      : undefined;
  const field = (
    <SettingRow
      label="Effort"
      htmlFor="settings-reasoning-effort"
      hint={hint}
      control={(
        <select
          id="settings-reasoning-effort"
          value={currentEffort}
          onChange={(e) => {
            const next = structuredClone(draft);
            next.reasoningEffort = e.target.value || undefined;
            setDraft(next);
          }}
          disabled={efforts.length === 0 && !currentEffort}
          className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
        >
          <option value="">Default</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {formatReasoningEffortLabel(effort) ?? effort}
            </option>
          ))}
        </select>
      )}
    />
  );
  return embedded ? field : (
    <SettingsSection title="Reasoning effort">
      <SettingList>{field}</SettingList>
    </SettingsSection>
  );
}
