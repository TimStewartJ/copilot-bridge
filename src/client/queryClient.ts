import { QueryClient } from "@tanstack/react-query";
import type { ManagementJobFilters } from "./management-job-api";

const CHAT_CACHE_GC_TIME = 15 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

queryClient.setQueryDefaults(["chat"], {
  staleTime: 30_000,
  retry: 1,
  refetchOnWindowFocus: true,
  gcTime: CHAT_CACHE_GC_TIME,
});

export const queryKeys = {
  settings: ["settings"] as const,
  models: ["models"] as const,
  modelClientInfo: ["models", "client-info"] as const,
  tags: ["tags"] as const,
  tasks: ["tasks"] as const,
  taskGroups: ["task-groups"] as const,
  restartStatus: ["restart-status"] as const,
  managementJobsRoot: ["management-jobs"] as const,
  managementJobs: (filters?: ManagementJobFilters) =>
    ["management-jobs", "list", filters ?? {}] as const,
  managementJob: (id: string) => ["management-jobs", "detail", id] as const,
  sessions: (opts?: { includeArchived?: boolean }) =>
    ["sessions", opts ?? {}] as const,
  task: (id: string) => ["task", id] as const,
  taskChecklistItems: (id: string) => ["task", id, "checklist-items"] as const,
  openChecklistItems: ["checklist-items", "open"] as const,
  taskGitStatus: (id: string) => ["task", id, "git-status"] as const,
  taskEnriched: (id: string) => ["task", id, "enriched"] as const,
  taskSessionStorage: (id: string, sessionIds: readonly string[]) =>
    ["task", id, "session-storage", ...sessionIds] as const,
  taskSchedules: (id: string) => ["task", id, "schedules"] as const,
  feed: (filters?: Record<string, unknown>) =>
    filters ? ["feed", filters] as const : ["feed"] as const,
  scheduleSessions: (id: string) => ["schedule", id, "sessions"] as const,
  sessionWorkspace: (sessionId: string, taskId?: string) =>
    ["session-workspace", sessionId, taskId ?? null] as const,
  chatMessages: (sessionId: string) =>
    ["chat", sessionId, "messages"] as const,
  mcpStatus: (sessionId: string) => ["chat", sessionId, "mcp"] as const,
  dashboard: ["dashboard"] as const,
  copilotUsage: ["copilot-usage"] as const,
  updates: (channel?: string) => ["updates", channel ?? "default"] as const,
  relatedDocs: (tagIds: string[]) => ["related-docs", ...tagIds] as const,
};
