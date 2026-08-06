import { useCallback, useEffect, useRef, useState } from "react";
import { patchSettings, type AppSettings, type ModelFamilyDefaults } from "../api";
import { queryClient, queryKeys } from "../queryClient";
import { buildFamilyDefaultsPatch } from "../lib/model-family-defaults";
import type { CopilotContextTier } from "../../shared/copilot-context.js";

// Small debounce so clicking through effort options doesn't fire a write per click.
const STICKY_WRITE_DELAY_MS = 400;

function readFamilyDefaults(): ModelFamilyDefaults | undefined {
  return queryClient.getQueryData<AppSettings>(queryKeys.settings)?.familyDefaults;
}

/**
 * Sticky per-family launch defaults. Remembers the model plus the effort and
 * context tier that went with it, so switching families later restores a
 * complete configuration.
 *
 * Reads and writes go through the shared query client rather than the
 * `useSettings*` hooks, so this also works in components rendered outside a
 * QueryClientProvider.
 *
 * Writes only happen after the user actually touches the picker, so simply
 * opening a new chat never rewrites settings with auto-resolved values.
 */
export function useStickyModelFamilyDefaults({
  enabled,
  modelId,
  reasoningEffort,
  contextTier,
}: {
  enabled: boolean;
  modelId?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}) {
  const [familyDefaults, setFamilyDefaults] = useState<ModelFamilyDefaults | undefined>(
    () => readFamilyDefaults(),
  );
  const touchedRef = useRef(false);

  const markTouched = useCallback(() => {
    touchedRef.current = true;
  }, []);

  const resetTouched = useCallback(() => {
    touchedRef.current = false;
  }, []);

  // Pick up settings loaded or changed elsewhere, including from another device.
  useEffect(() => {
    if (!enabled) return;
    setFamilyDefaults(readFamilyDefaults());
    return queryClient.getQueryCache().subscribe(() => {
      setFamilyDefaults(readFamilyDefaults());
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !touchedRef.current || !modelId) return;
    const patch = buildFamilyDefaultsPatch({
      current: familyDefaults,
      modelId,
      reasoningEffort,
      contextTier,
    });
    if (!patch) return;
    const timer = setTimeout(() => {
      // Fire and forget: a failed write must never block starting or switching a chat.
      void patchSettings({ familyDefaults: patch })
        .then((settings) => {
          queryClient.setQueryData(queryKeys.settings, settings);
        })
        .catch(() => {});
    }, STICKY_WRITE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, modelId, reasoningEffort, contextTier, familyDefaults]);

  return { familyDefaults, markTouched, resetTouched };
}
