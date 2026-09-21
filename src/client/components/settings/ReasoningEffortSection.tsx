import type { AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { formatReasoningEffortLabel, getModelReasoningEfforts } from "../../reasoning-effort";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";

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

  const field = (
      <div className={DS.layout.formGroup}>
        <div className="space-y-2">
          <label htmlFor="settings-reasoning-effort" className={DS.field.label}>Effort</label>
          <select
            id="settings-reasoning-effort"
            value={currentEffort}
            onChange={(e) => {
              const next = structuredClone(draft);
              next.reasoningEffort = e.target.value || undefined;
              setDraft(next);
            }}
            disabled={efforts.length === 0 && !currentEffort}
            className={cx(DS.field.input, DS.field.inputSize.md)}
          >
            <option value="">Default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {formatReasoningEffortLabel(effort) ?? effort}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-faint">
            {savedEffortUnavailable
              ? "This saved effort is not advertised for the current model. It is preserved until you choose another value."
              : efforts.length > 0
              ? "Levels come straight from the SDK for the selected model."
              : "The selected model does not expose configurable reasoning levels."}
          </p>
        </div>
      </div>
  );
  return embedded ? field : (
    <SettingsSection title="Reasoning effort" description="Default effort for new chats. Higher levels can use more time and tokens.">
      {field}
    </SettingsSection>
  );
}
