import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refreshModels, type AppSettings } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { useModelClientInfoQuery } from "../../hooks/queries/useModelClientInfo";
import { queryKeys } from "../../queryClient";
import { timeAgo } from "../../time";
import { AlertTriangle, RotateCw } from "lucide-react";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "../shared/Skeleton";
import { SettingsSection } from "./SettingsSection";
import {
  getContextTierLabel,
  modelSupportsLongContext,
  type CopilotContextTier,
} from "../../../shared/copilot-context.js";

export function shouldClearUnsupportedContextTier({
  contextTier,
  modelsLoaded,
  currentModel,
  selectedModelSupportsLongContext,
  selectedModelKnown,
}: {
  contextTier?: CopilotContextTier;
  modelsLoaded: boolean;
  currentModel: string;
  selectedModelSupportsLongContext: boolean;
  selectedModelKnown: boolean;
}): boolean {
  return Boolean(contextTier)
    && modelsLoaded
    && (!currentModel || selectedModelKnown)
    && !selectedModelSupportsLongContext;
}

/**
 * Validates the SDK/CLI client creation timestamp for display. Returns the
 * usable ISO string, or null when it is missing or unparseable.
 */
export function describeClientAge(createdAt: string | null | undefined): { iso: string } | null {
  if (!createdAt) return null;
  if (!Number.isFinite(new Date(createdAt).getTime())) return null;
  return { iso: createdAt };
}

export function ModelSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const { data: models, isLoading, error } = useModelsQuery();
  const { data: clientInfo } = useModelClientInfoQuery();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [, setAgeTick] = useState(0);

  const availableModels = (models ?? [])
    .filter((m) => !m.policy || m.policy.state !== "disabled")
    .sort((a, b) => a.name.localeCompare(b.name));

  const currentModel = draft.model ?? "";
  const selectedModel = availableModels.find((model) => model.id === currentModel);
  const supportsLongContext = modelSupportsLongContext(selectedModel);
  const currentContextTier = supportsLongContext ? (draft.contextTier ?? "default") : "";
  const modelsLoaded = models !== undefined;
  const formatMultiplier = (multiplier: unknown) =>
    typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier !== 1
      ? ` (${multiplier}×)`
      : "";
  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const refreshedModels = await refreshModels();
      queryClient.setQueryData(queryKeys.models, refreshedModels);
    } catch (refreshErr) {
      setRefreshError(refreshErr instanceof Error ? refreshErr.message : String(refreshErr));
    } finally {
      setRefreshing(false);
      // The client may have rotated even if listing models afterward failed, so
      // refetch the creation timestamp regardless of success.
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelClientInfo });
    }
  };

  const clientAge = describeClientAge(clientInfo?.createdAt);
  const clientCreatedAtIso = clientAge?.iso ?? null;

  useEffect(() => {
    if (!clientCreatedAtIso) return;
    const interval = setInterval(() => setAgeTick((tick) => tick + 1), 30_000);
    return () => clearInterval(interval);
  }, [clientCreatedAtIso]);

  useEffect(() => {
    if (!shouldClearUnsupportedContextTier({
      contextTier: draft.contextTier,
      modelsLoaded,
      currentModel,
      selectedModelSupportsLongContext: supportsLongContext,
      selectedModelKnown: selectedModel !== undefined,
    })) return;
    const next = structuredClone(draft);
    next.contextTier = undefined;
    setDraft(next);
  }, [currentModel, draft, modelsLoaded, selectedModel, setDraft, supportsLongContext]);

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
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-text-faint">
                Refresh rotates the SDK client when no sessions are active, so newly entitled models appear without restarting Bridge.
              </p>
              <button
                type="button"
                onClick={() => { void handleRefresh(); }}
                disabled={refreshing}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-surface disabled:opacity-50"
              >
                <RotateCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing" : "Refresh"}
              </button>
            </div>
            {refreshError && (
              <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                {refreshError}
              </div>
            )}
            <select
              value={currentModel}
              onChange={(e) => {
                const next = structuredClone(draft);
                next.model = e.target.value || undefined;
                const nextModel = availableModels.find((model) => model.id === next.model);
                if (!modelSupportsLongContext(nextModel)) {
                  next.contextTier = undefined;
                } else if (!next.contextTier) {
                  next.contextTier = "default";
                }
                setDraft(next);
              }}
              className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer"
            >
              <option value="">Default (SDK default)</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{formatMultiplier(m.billing?.multiplier)}
                </option>
              ))}
            </select>
            {currentModel && (
              <p className="text-xs text-text-faint">
                Model ID: <code className="text-text-muted">{currentModel}</code>
              </p>
            )}
            {supportsLongContext && (
              <div className="space-y-1">
                <label className="block text-xs font-medium text-text-secondary" htmlFor="context-tier-select">
                  Context tier
                </label>
                <select
                  id="context-tier-select"
                  value={currentContextTier}
                  onChange={(e) => {
                    const next = structuredClone(draft);
                    next.contextTier = e.target.value as CopilotContextTier;
                    setDraft(next);
                  }}
                  className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer"
                >
                  <option value="default">{getContextTierLabel(selectedModel, "default") ?? "Standard context"}</option>
                  <option value="long_context">{getContextTierLabel(selectedModel, "long_context") ?? "Long context"} · higher price</option>
                </select>
                <p className="text-xs text-text-faint">
                  Long context uses the model&apos;s larger context window and different token pricing.
                </p>
              </div>
            )}
          </div>
        )}
        {clientAge && (
          <p
            className="mt-3 border-t border-border pt-3 text-xs text-text-faint"
            title={`SDK client created ${new Date(clientAge.iso).toLocaleString()}`}
          >
            Active SDK client started {timeAgo(clientAge.iso)}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
