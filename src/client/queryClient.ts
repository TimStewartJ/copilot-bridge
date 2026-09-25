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
  bridgeRuntimeStatus: ["bridge-runtime-status"] as const,
  managementJobsRoot: ["management-jobs"] as const,
  managementJobs: (filters?: ManagementJobFilters) =>
    ["management-jobs", "list", filters ?? {}] as const,
  managementJob: (id: string) => ["management-jobs", "detail", id] as const,
  sessions: (opts?: { includeArchived?: boolean }) =>
    ["sessions", opts ?? {}] as const,
  externalSessionUse: (sessionIds: readonly string[]) =>
    ["external-session-use", ...sessionIds] as const,
  task: (id: string) => ["task", id] as const,
  taskChecklistItems: (id: string) => ["task", id, "checklist-items"] as const,
  taskAgentDefinitions: (id: string) => ["task", id, "agent-definitions"] as const,
  openChecklistItems: ["checklist-items", "open"] as const,
  taskGitStatus: (id: string) => ["task", id, "git-status"] as const,
  taskMomentumEvents: (id: string) => ["task", id, "momentum-events"] as const,
  taskEnriched: (id: string) => ["task", id, "enriched"] as const,
  taskSessionStorage: (id: string, sessionIds: readonly string[]) =>
    ["task", id, "session-storage", ...sessionIds] as const,
  taskSchedules: (id: string) => ["task", id, "schedules"] as const,
  scheduleSessions: (id: string) => ["schedule", id, "sessions"] as const,
  /** Kept outside ["sessions"]: those caches hold Session[] and are patched in place. */
  taskArchivedSessionsRoot: ["task-archived-sessions"] as const,
  taskArchivedSessions: (id: string) => ["task-archived-sessions", id] as const,
  sessionWorkspace: (sessionId: string, taskId?: string) =>
    ["session-workspace", sessionId, taskId ?? null] as const,
  sessionModel: (sessionId: string) => ["session-model", sessionId] as const,
  sessionUsageMetrics: (sessionId: string) => ["session-usage-metrics", sessionId] as const,
  sessionDefers: (sessionId: string) => ["session-defers", sessionId] as const,
  chatMessages: (sessionId: string) =>
    ["chat", sessionId, "messages"] as const,
  mcpStatus: (sessionId: string) => ["chat", sessionId, "mcp"] as const,
  dashboard: ["dashboard"] as const,
  workMap: (includeArchived: boolean, assignedToMe: boolean) =>
    ["dashboard", "work-map", { includeArchived, assignedToMe }] as const,
  copilotUsage: (scope?: {
    taskId?: string;
    includeSessions?: boolean;
    sessionIds?: readonly string[];
    range?: string;
  }) =>
    [
      "copilot-usage",
      scope?.taskId ?? null,
      scope?.includeSessions ?? true,
      scope?.range ?? "all",
      ...(scope?.sessionIds ?? []),
    ] as const,
  copilotQuota: ["copilot-usage", "quota"] as const,
  updates: (channel?: string) => ["updates", channel ?? "default"] as const,
  relatedDocs: (tagIds: string[]) => ["related-docs", ...tagIds] as const,
  docsRoot: ["docs"] as const,
  docsTree: ["docs", "tree"] as const,
  docsPage: (path: string) => ["docs", "page", path] as const,
  docsCollection: (folder: string) => ["docs", "collection", folder] as const,
  docsSchema: (folder: string) => ["docs", "schema", folder] as const,
  docsSearch: (query: string) => ["docs", "search", query] as const,
  docsWikilinks: (targets: readonly string[]) => ["docs", "wikilinks", ...targets] as const,
};
