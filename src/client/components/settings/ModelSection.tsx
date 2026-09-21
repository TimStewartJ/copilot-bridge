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
import { ReasoningEffortSection } from "./ReasoningEffortSection";
import { Button, Details } from "../../design/primitives";
import {
  getContextTierLabel,
  modelSupportsLongContext,
  type CopilotContextTier,
} from "../../../shared/copilot-context.js";
import { DS, cx } from "../../design/tokens";

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

  return (
    <SettingsSection
      title="Chat defaults"
      description="Model and effort for new chats. Existing sessions keep their current settings."
      action={(
        <Button size="sm" variant="ghost" onClick={() => void handleRefresh()} disabled={refreshing}
          title="Refresh available models. The SDK client rotates when no sessions are active."
          icon={<RotateCw size={13} className={refreshing ? "animate-spin" : undefined} />}>
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      )}
    >
      <div className={DS.layout.formGroup}>
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
          <div role="alert" className="flex items-center gap-2 text-xs text-error">
            <AlertTriangle className="w-3 h-3" />
            Failed to load models
          </div>
        ) : (
          <div className="space-y-4">
            {refreshError && (
              <div role="alert" className={cx(DS.notice.surface, "text-error")}>{refreshError}</div>
            )}
            <div className="grid min-w-0 gap-4 @[34rem]/settings-content:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-2">
              <label htmlFor="settings-model-select" className={DS.field.label}>Model</label>
            <select
              id="settings-model-select"
              value={currentModel}
              onChange={(e) => {
                const next = structuredClone(draft);
                next.model = e.target.value || undefined;
                const nextModel = availableModels.find((model) => model.id === next.model);
                if (nextModel?.supportedReasoningEfforts?.length === 0) {
                  next.reasoningEffort = undefined;
                }
                if (shouldClearUnsupportedContextTier({
                  contextTier: next.contextTier,
                  modelsLoaded,
                  currentModel: next.model ?? "",
                  selectedModelSupportsLongContext: modelSupportsLongContext(nextModel),
                  selectedModelKnown: nextModel !== undefined,
                })) {
                  next.contextTier = undefined;
                } else if (modelSupportsLongContext(nextModel) && !next.contextTier) {
                  next.contextTier = "default";
                }
                setDraft(next);
              }}
              className={cx(DS.field.input, DS.field.inputSize.md)}
            >
              <option value="">Default (SDK default)</option>
              {currentModel && !selectedModel && <option value={currentModel}>{currentModel} (not in the current catalog)</option>}
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{formatMultiplier(m.billing?.multiplier)}
                </option>
              ))}
            </select>
            </div>
            <ReasoningEffortSection draft={draft} setDraft={setDraft} embedded />
            </div>
            {modelsLoaded && !supportsLongContext && draft.contextTier === "long_context" && (
              <div role="status" className="text-xs leading-relaxed text-warning">
                The saved long-context preference is not advertised for this model. It has been preserved.
                <Button variant="ghost" size="sm" className="ml-1" onClick={() => setDraft({ ...draft, contextTier: undefined })}>Use model default</Button>
              </div>
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
                  className={cx(DS.field.input, DS.field.inputSize.md)}
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
        <Details label="Model catalog details">
          <div className="space-y-1 pt-2 text-xs leading-relaxed text-text-secondary">
            {currentModel && <p>Model ID: <code>{currentModel}</code></p>}
            <p>Refresh rotates the SDK client when no sessions are active, so newly entitled models appear without restarting Bridge.</p>
            {clientAge && <p title={`SDK client created ${new Date(clientAge.iso).toLocaleString()}`}>Active SDK client started {timeAgo(clientAge.iso)}</p>}
          </div>
        </Details>
      </div>
    </SettingsSection>
  );
}
