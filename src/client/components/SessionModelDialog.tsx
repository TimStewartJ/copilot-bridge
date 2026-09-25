import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import {
  fetchModels,
  patchSessionModel,
  refreshModels,
  type CopilotContextTier,
  type ModelInfo,
  type ReasoningEffort,
  type SessionModelCompactionDecision,
  type SessionModelState,
  type SessionModelSwitchConfirmation,
} from "../api";
import { queryClient, queryKeys } from "../queryClient";
import { DS } from "../design/tokens";
import { useModalDialog } from "./shared/useModalDialog";
import { LaunchOptionRow } from "./shared/LaunchOptionControls";
import ModelPresetPicker from "./shared/ModelPresetPicker";
import {
  buildContextTierOptions,
  buildReasoningEffortOptions,
  getSelectableModels,
} from "../lib/new-session-launch";
import type { ModelPresetSelection } from "../lib/model-presets";
import { useModelPresets } from "../hooks/useModelPresets";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import { modelSupportsLongContext } from "../../shared/copilot-context.js";
import { formatReasoningEffortLabel } from "../reasoning-effort";
import { useSessionModelQuery } from "../hooks/queries/useSessionModel";
import { formatSessionModelLabel } from "../lib/session-model";
import ModelSwitchCompactionPrompt, { MODEL_SWITCH_COMPACTION_TITLE } from "./ModelSwitchCompactionPrompt";

interface ModelSwitchRequest {
  model: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

interface PendingModelSwitchConfirmation {
  request: ModelSwitchRequest;
  confirmation: SessionModelSwitchConfirmation;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getPreferredReasoningEffort(model?: ModelInfo): ReasoningEffort | undefined {
  const supported = model?.supportedReasoningEfforts;
  if (!supported || supported.length === 0) return undefined;
  if (model?.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return supported[0];
}

export function canKeepCurrentReasoningEffortForModel({
  supportedReasoningEfforts,
  currentReasoningEffort,
  currentEffortLookupReady,
}: {
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  currentReasoningEffort?: string;
  currentEffortLookupReady: boolean;
}): boolean {
  if (!supportedReasoningEfforts) return true;
  if (!currentEffortLookupReady) return false;
  if (supportedReasoningEfforts.length === 0) return true;
  if (!currentReasoningEffort) return true;
  return supportedReasoningEfforts.includes(currentReasoningEffort);
}

/**
 * Changes one session's model, reasoning effort and context tier. Mount it only while it is open:
 * its drafts start from the session's cached model state each time it mounts.
 */
export default function SessionModelDialog({
  sessionId,
  sessionSummary,
  busy,
  onClose,
}: {
  sessionId: string;
  /** Shown after the dialog's explanation so the user can tell which chat they are changing. */
  sessionSummary?: string;
  /** A working session cannot switch models; Save stays disabled until it is idle. */
  busy: boolean;
  onClose: () => void;
}) {
  const initialState = queryClient.getQueryData<SessionModelState>(queryKeys.sessionModel(sessionId));
  const [modelOptions, setModelOptions] = useState<ModelInfo[] | null>(null);
  const [modelOptionsLoading, setModelOptionsLoading] = useState(false);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState(initialState?.model ?? "");
  const [modelPresetDraft, setModelPresetDraft] = useState<ModelPresetSlot | undefined>();
  const [reasoningDraft, setReasoningDraft] = useState<"" | ReasoningEffort>("");
  const [contextTierDraft, setContextTierDraft] = useState<"" | CopilotContextTier>(initialState?.contextTier ?? "");
  const [modelSwitchSaving, setModelSwitchSaving] = useState(false);
  const [modelSwitchError, setModelSwitchError] = useState<string | null>(null);
  const [modelSwitchConfirmation, setModelSwitchConfirmation] = useState<PendingModelSwitchConfirmation | null>(null);
  const modelDialogTouchedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const modelDialogQuery = useSessionModelQuery(sessionId);
  const availableModels = getSelectableModels(modelOptions ?? []);
  const selectedDialogModel = modelOptions?.find((model) => model.id === modelDraft);
  const selectedDialogModelSupportsLongContext = modelSupportsLongContext(selectedDialogModel);
  const supportedReasoningEfforts = selectedDialogModel?.supportedReasoningEfforts;
  const selectedDialogDisablesReasoning = supportedReasoningEfforts?.length === 0;
  const currentReasoningEffort = modelDialogQuery.data?.reasoningEffort;
  const currentEffortLookupReady = modelDialogQuery.isSuccess && !!modelDialogQuery.data;
  const preferredReasoningEffort = getPreferredReasoningEffort(selectedDialogModel);
  const canKeepCurrentReasoningEffort = canKeepCurrentReasoningEffortForModel({
    supportedReasoningEfforts,
    currentReasoningEffort,
    currentEffortLookupReady,
  });
  // A model with no advertised efforts keeps whatever the session already has
  // (the save omits the field), so name that effort instead of "Default".
  const keepCurrentEffortLabel = supportedReasoningEfforts === undefined
    ? formatReasoningEffortLabel(currentReasoningEffort)
    : undefined;
  const dialogReasoningOptions = buildReasoningEffortOptions(supportedReasoningEfforts)
    .map((option) => (option.value === null && keepCurrentEffortLabel
      ? { ...option, label: keepCurrentEffortLabel }
      : option));
  const dialogSelectedReasoningEffort = reasoningDraft
    || (currentReasoningEffort && supportedReasoningEfforts?.includes(currentReasoningEffort)
      ? currentReasoningEffort
      : undefined);
  const dialogContextOptions = buildContextTierOptions(selectedDialogModel);
  const dialogSelectedContextTier = selectedDialogModelSupportsLongContext
    ? (contextTierDraft || "default")
    : undefined;
  const reasoningDraftCanBeSubmitted =
    !!reasoningDraft
    && (!supportedReasoningEfforts || supportedReasoningEfforts.includes(reasoningDraft));
  // Memory is shared with the new-chat picker.
  const modelPresetMemory = useModelPresets({ enabled: true });
  const dialogPresetSlot = modelPresetDraft
    ?? modelPresetMemory.findSlotForModel(modelDraft, availableModels);
  /**
   * Applies a preset or model pick to the unsaved dialog drafts only. Remembered
   * effort/context are restored when the target model can still honor them.
   */
  const applyDialogSelection = useCallback((selection: ModelPresetSelection) => {
    modelDialogTouchedRef.current = true;
    const modelInfo = modelOptions?.find((model) => model.id === selection.modelId);
    setModelPresetDraft(selection.slot);
    setModelDraft(selection.modelId);
    setReasoningDraft(
      selection.reasoningEffort
        && modelInfo?.supportedReasoningEfforts?.includes(selection.reasoningEffort)
        ? selection.reasoningEffort
        : "",
    );
    setContextTierDraft(
      modelSupportsLongContext(modelInfo) ? (selection.contextTier ?? "default") : "",
    );
  }, [modelOptions]);

  const handleDialogPresetChange = useCallback((slot: ModelPresetSlot) => {
    const selection = modelPresetMemory.selectPreset(slot, {
      models: availableModels,
      selectedModelId: modelDraft,
      selectedPresetSlot: dialogPresetSlot,
    });
    if (selection) applyDialogSelection(selection);
  }, [applyDialogSelection, availableModels, dialogPresetSlot, modelDraft, modelPresetMemory]);

  const handleDialogModelChange = useCallback((slot: ModelPresetSlot, modelId: string) => {
    applyDialogSelection(modelPresetMemory.selectModel(slot, modelId));
  }, [applyDialogSelection, modelPresetMemory]);

  const canSaveModelSwitch =
    !!modelDraft.trim()
    && !modelSwitchSaving
    && !modelOptionsLoading
    && !busy
    && (canKeepCurrentReasoningEffort || reasoningDraftCanBeSubmitted || !supportedReasoningEfforts);

  const loadModelOptions = useCallback(async (forceRefresh = false) => {
    setModelOptionsLoading(true);
    setModelOptionsError(null);
    try {
      const models = forceRefresh ? await refreshModels() : await fetchModels();
      queryClient.setQueryData(queryKeys.models, models);
      if (!mountedRef.current) return;
      setModelOptions(models);
    } catch (error) {
      if (mountedRef.current) setModelOptionsError(getErrorMessage(error));
    } finally {
      if (mountedRef.current) setModelOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (modelOptions || modelOptionsLoading || modelOptionsError) return;
    void loadModelOptions();
  }, [loadModelOptions, modelOptions, modelOptionsError, modelOptionsLoading]);

  useEffect(() => {
    if (modelDialogTouchedRef.current || !modelDialogQuery.data) return;
    setModelDraft(modelDialogQuery.data.model ?? "");
    setModelPresetDraft(undefined);
    setContextTierDraft(modelDialogQuery.data.contextTier ?? "");
  }, [modelDialogQuery.data]);

  useEffect(() => {
    if (!supportedReasoningEfforts) {
      return;
    }
    if (reasoningDraft && !supportedReasoningEfforts.includes(reasoningDraft)) {
      setReasoningDraft(preferredReasoningEffort ?? "");
      return;
    }
    if (!reasoningDraft && !canKeepCurrentReasoningEffort) {
      setReasoningDraft(preferredReasoningEffort ?? "");
    }
  }, [
    canKeepCurrentReasoningEffort,
    currentReasoningEffort,
    preferredReasoningEffort,
    reasoningDraft,
    supportedReasoningEfforts,
  ]);

  const closeModelDialog = useCallback(() => {
    if (modelSwitchSaving) return;
    onClose();
  }, [modelSwitchSaving, onClose]);

  const { dialogProps: modelDialogProps } = useModalDialog({
    onDismiss: closeModelDialog,
    open: true,
    dismissible: !modelSwitchSaving,
    label: modelSwitchConfirmation ? MODEL_SWITCH_COMPACTION_TITLE : "Change session model",
  });

  const submitModelSwitch = useCallback(async (
    request: ModelSwitchRequest,
    compactionDecision?: SessionModelCompactionDecision,
  ) => {
    setModelSwitchSaving(true);
    setModelSwitchError(null);
    let closeAfterSave = false;
    try {
      const result = compactionDecision
        ? await patchSessionModel(sessionId, request.model, request.reasoningEffort, request.contextTier, {
            compactionDecision,
          })
        : await patchSessionModel(sessionId, request.model, request.reasoningEffort, request.contextTier);
      if (result.status === "confirmation_required") {
        if (mountedRef.current) setModelSwitchConfirmation({ request, confirmation: result.confirmation });
        return;
      }
      if (result.status === "cancelled") {
        if (mountedRef.current) {
          setModelSwitchConfirmation(null);
          setModelSwitchError(result.warning ?? (
            compactionDecision === "compact"
              ? "The conversation still doesn't fit after compacting, so the model wasn't changed."
              : "The model wasn't changed."
          ));
        }
        return;
      }
      const nextReasoningEffort = selectedDialogDisablesReasoning
        ? undefined
        : result.reasoningEffort
          ?? (request.reasoningEffort || modelDialogQuery.data?.reasoningEffort);
      const nextContextTier = result.contextTier ?? request.contextTier;
      const savedModelId = result.modelId ?? result.model;
      const nextState: SessionModelState = {
        model: savedModelId,
        ...(nextReasoningEffort ? { reasoningEffort: nextReasoningEffort } : {}),
        ...(nextContextTier ? { contextTier: nextContextTier } : {}),
        source: "live",
      };
      queryClient.setQueryData(queryKeys.sessionModel(sessionId), nextState);
      // A saved switch is a committed choice, so it feeds the same memory the
      // new-chat picker reads.
      if (dialogPresetSlot) {
        modelPresetMemory.remember({
          slot: dialogPresetSlot,
          modelId: savedModelId,
          reasoningEffort: nextReasoningEffort,
          contextTier: nextContextTier,
        });
      }
      closeAfterSave = true;
    } catch (error) {
      if (mountedRef.current) setModelSwitchError(getErrorMessage(error));
      // A long compaction can outlive the request, so re-read what the session is actually on.
      if (compactionDecision) void queryClient.invalidateQueries({ queryKey: queryKeys.sessionModel(sessionId) });
    } finally {
      if (mountedRef.current) setModelSwitchSaving(false);
    }
    if (closeAfterSave && mountedRef.current) onClose();
  }, [
    sessionId,
    modelDialogQuery.data?.reasoningEffort,
    dialogPresetSlot,
    modelPresetMemory,
    onClose,
    selectedDialogDisablesReasoning,
  ]);

  const handleSaveModelSwitch = useCallback(async () => {
    const model = modelDraft.trim();
    if (!model) return;

    const submittedReasoningEffort = reasoningDraftCanBeSubmitted
      ? reasoningDraft
      : !canKeepCurrentReasoningEffort
        ? preferredReasoningEffort
      : undefined;
    const submittedContextTier = selectedDialogModelSupportsLongContext
      ? (contextTierDraft || "default")
      : undefined;
    await submitModelSwitch({
      model,
      reasoningEffort: submittedReasoningEffort,
      contextTier: submittedContextTier,
    });
  }, [
    contextTierDraft,
    modelDraft,
    reasoningDraft,
    reasoningDraftCanBeSubmitted,
    canKeepCurrentReasoningEffort,
    preferredReasoningEffort,
    selectedDialogModelSupportsLongContext,
    submitModelSwitch,
  ]);

  const handleCompactAndSwitch = useCallback(async () => {
    if (!modelSwitchConfirmation) return;
    await submitModelSwitch(modelSwitchConfirmation.request, "compact");
  }, [modelSwitchConfirmation, submitModelSwitch]);

  if (modelSwitchConfirmation) {
    return (
      <div
        className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
        {...modelDialogProps}
        onClick={closeModelDialog}
      >
        <ModelSwitchCompactionPrompt
          confirmation={modelSwitchConfirmation.confirmation}
          compacting={modelSwitchSaving}
          error={modelSwitchError}
          onCompact={() => {
            void handleCompactAndSwitch();
          }}
          onKeepCurrentModel={closeModelDialog}
        />
      </div>
    );
  }

  return (
    <div
      className={DS.surface.scrim}
      {...modelDialogProps}
      onClick={closeModelDialog}
    >
      <div
        className={`${DS.surface.dialog} w-full max-w-md space-y-4 p-5`}
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <div className={DS.text.title}>Change session model</div>
          <p className={`mt-1 ${DS.text.prose}`}>
            Changes apply only to this session.
            {sessionSummary ? ` ${sessionSummary}` : ""}
          </p>
        </div>

        <div className="text-[13px]">
          <span className="text-text-muted">Current model</span>
          <span className="ml-2 text-text-primary">
            {modelDialogQuery.error
              ? "Unable to load current model"
              : formatSessionModelLabel(modelDialogQuery.data, modelOptions)}
          </span>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            {modelOptionsError ? (
              <div className="text-xs text-error" role="alert">
                <div>Failed to load models: {modelOptionsError}</div>
                <button
                  type="button"
                  className={`${DS.button.base} ${DS.button.size.sm} ${DS.button.variant.danger} -ml-2.5 mt-1`}
                  onClick={() => {
                    void loadModelOptions();
                  }}
                >
                  Retry
                </button>
              </div>
            ) : modelOptionsLoading ? (
              <div className={`flex h-10 items-center text-[13px] md:h-9 ${DS.motion.live}`} role="status">
                Loading models...
              </div>
            ) : (
              <ModelPresetPicker
                idPrefix="session-model"
                models={availableModels}
                selectedModelId={modelDraft}
                selectedPresetSlot={dialogPresetSlot}
                globalDefaultModelId={modelPresetMemory.globalDefaultModelId}
                presets={modelPresetMemory.presets}
                disabled={modelSwitchSaving}
                onSelectPreset={handleDialogPresetChange}
                onSelectModel={handleDialogModelChange}
              />
            )}
            {!modelOptionsError && (
              <button
                type="button"
                onClick={() => { void loadModelOptions(true); }}
                disabled={modelOptionsLoading || modelSwitchSaving}
                className={`${DS.button.base} ${DS.button.size.sm} ${DS.button.variant.ghost} -ml-2.5`}
              >
                <RotateCw className={`h-3 w-3 ${modelOptionsLoading ? "animate-spin" : ""}`} aria-hidden="true" />
                Refresh model list
              </button>
            )}
          </div>

          {!selectedDialogDisablesReasoning && (
            <div className="space-y-1.5">
              <LaunchOptionRow
                ariaLabel="Effort for this session"
                options={dialogReasoningOptions}
                selectedValue={dialogSelectedReasoningEffort}
                onChange={(value) => {
                  modelDialogTouchedRef.current = true;
                  setReasoningDraft(value ?? "");
                }}
                disabled={modelSwitchSaving}
              />
              {!canKeepCurrentReasoningEffort && currentEffortLookupReady && currentReasoningEffort && (
                <div className="text-xs text-text-faint">
                  Current: {formatReasoningEffortLabel(currentReasoningEffort)}
                  {" (not supported by selected model)"}
                </div>
              )}
            </div>
          )}

          {dialogContextOptions.length > 0 && (
            <LaunchOptionRow
              ariaLabel="Context for this session"
              options={dialogContextOptions}
              selectedValue={dialogSelectedContextTier}
              onChange={(value) => {
                modelDialogTouchedRef.current = true;
                setContextTierDraft(value ?? "");
              }}
              disabled={modelSwitchSaving}
            />
          )}
        </div>

        {modelSwitchError && (
          <div className="text-xs text-error" role="alert">
            {modelSwitchError}
          </div>
        )}

        {busy && (
          <div className="text-xs text-text-faint" role="status">
            This session is working. You can save once it is idle.
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={`${DS.button.base} ${DS.button.size.md} ${DS.button.variant.ghost}`}
            onClick={closeModelDialog}
            disabled={modelSwitchSaving}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${DS.button.base} ${DS.button.size.md} ${DS.button.variant.primary}`}
            onClick={() => {
              void handleSaveModelSwitch();
            }}
            disabled={!canSaveModelSwitch}
            title={busy ? "This session is busy" : undefined}
          >
            {modelSwitchSaving && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
