import type { AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { AlertTriangle } from "lucide-react";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "../shared/Skeleton";
import { SettingsSection } from "./SettingsSection";

export function ModelSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const { data: models, isLoading, error } = useModelsQuery();

  const availableModels = (models ?? [])
    .filter((m) => !m.policy || m.policy.state !== "disabled")
    .sort((a, b) => a.name.localeCompare(b.name));

  const currentModel = draft.model ?? "";

  return (
    <SettingsSection
      title="Model"
      description="Choose the default AI model for new sessions. Existing sessions keep their current model unless changed explicitly."
    >
      <div className="bg-bg-elevated border border-border rounded-md p-4">
        {isLoading ? (
          <LoadingSkeletonRegion
            isLoading
            label="Loading available models"
            className="space-y-2"
          >
            <Skeleton height={34} className="w-full" />
            <SkeletonText lines={1} widths={["42%"]} lineClassName="h-2.5" />
          </LoadingSkeletonRegion>
        ) : error ? (
          <div className="flex items-center gap-2 text-xs text-error">
            <AlertTriangle className="w-3 h-3" />
            Failed to load models
          </div>
        ) : (
          <div className="space-y-2">
            <select
              value={currentModel}
              onChange={(e) => {
                const next = structuredClone(draft);
                next.model = e.target.value || undefined;
                setDraft(next);
              }}
              className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer"
            >
              <option value="">Default (SDK default)</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.billing && m.billing.multiplier !== 1 ? ` (${m.billing.multiplier}×)` : ""}
                </option>
              ))}
            </select>
            {currentModel && (
              <p className="text-xs text-text-faint">
                Model ID: <code className="text-text-muted">{currentModel}</code>
              </p>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
