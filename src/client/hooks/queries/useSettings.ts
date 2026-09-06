import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, patchSettings, type AppSettingsUpdates } from "../../api";
import { queryKeys } from "../../queryClient";

export function useSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: fetchSettings,
  });
}

export function useSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updates: AppSettingsUpdates) => patchSettings(updates),
    onSuccess: (data, updates) => {
      queryClient.setQueryData(queryKeys.settings, data);
      if ("focusNotifications" in updates) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.focusRoot });
      }
    },
  });
}
