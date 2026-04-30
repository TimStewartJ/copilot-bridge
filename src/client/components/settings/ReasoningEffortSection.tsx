import type { AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { SettingsSection } from "./SettingsSection";

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max (Claude)" },
  { value: "xhigh", label: "Extra High (GPT)" },
];

export function ReasoningEffortSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const { data: models } = useModelsQuery();

  const currentModel = draft.model ?? "";
  const selectedModelInfo = (models ?? []).find((m) => m.id === currentModel);
  const supportedEfforts = selectedModelInfo?.supportedReasoningEfforts;

  const currentEffort = draft.reasoningEffort ?? "";

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
              next.reasoningEffort = (e.target.value || undefined) as AppSettings["reasoningEffort"];
              setDraft(next);
            }}
            className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer"
          >
            {EFFORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {supportedEfforts && supportedEfforts.length > 0 && (
            <p className="text-xs text-text-faint">
              Supported by current model:{" "}
              {supportedEfforts.map((e) => EFFORT_OPTIONS.find((o) => o.value === e)?.label ?? e).join(", ")}
            </p>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
