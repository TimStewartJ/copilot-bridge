import type { AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { formatReasoningEffortLabel, getModelReasoningEfforts } from "../../reasoning-effort";
import { SettingsSection } from "./SettingsSection";

export function ReasoningEffortSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const { data: models } = useModelsQuery();

  const currentModel = draft.model ?? "";
  const currentEffort = draft.reasoningEffort ?? "";

  const efforts = getModelReasoningEfforts(models, currentModel || undefined);
  // Keep a previously-saved effort visible even if the current model no longer
  // advertises it, so switching models never silently drops the user's choice.
  if (currentEffort && !efforts.includes(currentEffort)) efforts.push(currentEffort);

  return (
    <SettingsSection
      title="Reasoning Effort"
      description="Control how much reasoning the model applies for new sessions. Higher effort may produce better results but uses more tokens. Existing sessions keep their current setting unless changed explicitly."
    >
      <div className="bg-bg-elevated border border-border rounded-md p-4">
        <div className="space-y-2">
          <select
            value={currentEffort}
            onChange={(e) => {
              const next = structuredClone(draft);
              next.reasoningEffort = e.target.value || undefined;
              setDraft(next);
            }}
            className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer"
          >
            <option value="">Default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {formatReasoningEffortLabel(effort) ?? effort}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-faint">
            {efforts.length > 0
              ? "Levels come straight from the SDK for the selected model."
              : "The selected model does not expose configurable reasoning levels."}
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
