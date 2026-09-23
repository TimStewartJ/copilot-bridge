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
import { Button, Details, SettingList, SettingRow } from "../../design/primitives";
import { useSettingsWriter } from "../../hooks/queries/useSettings";
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

  const { error: writeError } = useSettingsWriter();
  const modelError = writeError?.keys.some((key) => key === "model" || key === "reasoningEffort" || key === "contextTier")
    ? writeError.message
    : null;

  const clientAge = describeClientAge(clientInfo?.createdAt);
  const clientCreatedAtIso = clientAge?.iso ?? null;

  useEffect(() => {
    if (!clientCreatedAtIso) return;
    const interval = setInterval(() => setAgeTick((tick) => tick + 1), 30_000);
    return () => clearInterval(interval);
  }, [clientCreatedAtIso]);

  const modelSelect = (
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
      aria-describedby={modelError ? "settings-model-error" : undefined}
      aria-invalid={modelError ? true : undefined}
      className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
    >
      <option value="">Default (SDK default)</option>
      {currentModel && !selectedModel && <option value={currentModel}>{currentModel} (not in the current catalog)</option>}
      {availableModels.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}{formatMultiplier(m.billing?.multiplier)}
        </option>
      ))}
    </select>
  );

  return (
    <SettingsSection
      title="New chats"
      description="Chats already open keep their own model."
      action={(
        <Button size="sm" variant="ghost" onClick={() => void handleRefresh()} disabled={refreshing}
          title="Refresh available models. The SDK client rotates when no sessions are active."
          icon={<RotateCw size={13} className={refreshing ? "animate-spin" : undefined} />}>
          {refreshing ? "Refreshing" : "Refresh models"}
        </Button>
      )}
    >
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
        <SettingList>
          {refreshError && <p role="alert" className="pb-3 text-xs text-error">{refreshError}</p>}
          <SettingRow label="Model" htmlFor="settings-model-select" control={modelSelect}>
            {modelError && <p id="settings-model-error" className="text-xs text-error">{modelError}</p>}
          </SettingRow>
          <ReasoningEffortSection draft={draft} setDraft={setDraft} embedded />
          {modelsLoaded && !supportsLongContext && draft.contextTier === "long_context" && (
            <SettingRow
              label="Context"
              hint="Long context was saved, but this model doesn't offer it. It is kept for now."
              control={<Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, contextTier: undefined })}>Use model default</Button>}
            />
          )}
          {supportsLongContext && (
            <SettingRow
              label="Context"
              htmlFor="context-tier-select"
              hint="Long context costs more per token."
              control={(
                <select
                  id="context-tier-select"
                  value={currentContextTier}
                  onChange={(e) => {
                    const next = structuredClone(draft);
                    next.contextTier = e.target.value as CopilotContextTier;
                    setDraft(next);
                  }}
                  className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
                >
                  <option value="default">{getContextTierLabel(selectedModel, "default") ?? "Standard context"}</option>
                  <option value="long_context">{getContextTierLabel(selectedModel, "long_context") ?? "Long context"} · higher price</option>
                </select>
              )}
            />
          )}
        </SettingList>
      )}
      <Details label="Model catalog details" className="mt-3">
        <div className="space-y-1 pt-2 text-xs leading-relaxed text-text-secondary">
          {currentModel && <p>Model ID: <code>{currentModel}</code></p>}
          <p>Refresh rotates the SDK client when no sessions are active, so newly entitled models appear without restarting Bridge.</p>
          {clientAge && <p title={`SDK client created ${new Date(clientAge.iso).toLocaleString()}`}>Active SDK client started {timeAgo(clientAge.iso)}</p>}
        </div>
      </Details>
    </SettingsSection>
  );
}
