import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, patchSettings, type AppSettings } from "../../api";
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
    mutationFn: (updates: Partial<AppSettings>) => patchSettings(updates),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings, data);
    },
  });
}
