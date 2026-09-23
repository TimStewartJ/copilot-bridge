import { useSyncExternalStore } from "react";
import { hashKey, useQuery, useMutation } from "@tanstack/react-query";
import { fetchSettings, patchSettings, type AppSettings, type AppSettingsUpdates } from "../../api";
import { queryClient, queryKeys } from "../../queryClient";
import { createSettingsWriter, type SettingsWriterSnapshot } from "../../lib/settings-writer";

export function useSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: fetchSettings,
  });
}

/**
 * Every settings write goes through this one writer, so writes from Settings, Helm and model
 * presets are sent one at a time and the cache always shows the latest intended settings.
 */
export const settingsWriter = createSettingsWriter({
  patch: patchSettings,
  fetch: fetchSettings,
  readCache: () => queryClient.getQueryData<AppSettings>(queryKeys.settings),
  writeCache: (settings) => queryClient.setQueryData(queryKeys.settings, settings),
  subscribeCache: (listener) => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryHash !== hashKey(queryKeys.settings)) return;
    // setQueryData (the writer's own optimistic view) is "manual"; only fetched results are news.
    if (event.action.type !== "success" || event.action.manual) return;
    listener(event.query.state.data as AppSettings | undefined);
  }),
});

export function useSettingsWriter(): SettingsWriterSnapshot {
  return useSyncExternalStore(settingsWriter.subscribe, settingsWriter.getSnapshot, settingsWriter.getSnapshot);
}

export function useSettingsMutation() {
  return useMutation({
    mutationFn: (updates: AppSettingsUpdates) => settingsWriter.patch(updates),
  });
}
