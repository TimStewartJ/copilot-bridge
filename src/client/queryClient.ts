import { QueryClient } from "@tanstack/react-query";
import type { ManagementJobFilters } from "./management-job-api";
import type { FocusHistoryFilter, FocusLaunchIdentity, FocusObjectType, FocusQuietConcernFilter } from "./api";

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
  taskEnriched: (id: string) => ["task", id, "enriched"] as const,
  taskSessionStorage: (id: string, sessionIds: readonly string[]) =>
    ["task", id, "session-storage", ...sessionIds] as const,
  taskSchedules: (id: string) => ["task", id, "schedules"] as const,
  focusSnapshot: ["dashboard", "focus", "snapshot"] as const,
  focusRoot: ["dashboard", "focus"] as const,
  focusDecisions: ["dashboard", "focus", "decisions"] as const,
  focusAlerts: ["dashboard", "focus", "alerts"] as const,
  focusDigests: ["dashboard", "focus", "digest"] as const,
  focusDigest: (id: string) => ["dashboard", "focus", "digest", id] as const,
  focusCleared: ["dashboard", "focus", "cleared"] as const,
  focusObject: (type: FocusObjectType, id: string) => ["dashboard", "focus", "object", type, id] as const,
  focusHistory: (filter: FocusHistoryFilter = {}) => ["dashboard", "focus", "history", filter] as const,
  focusTransitions: (id: string) => ["dashboard", "focus", "transitions", id] as const,
  focusAuthority: ["dashboard", "focus", "authority"] as const,
  focusCoverage: ["dashboard", "focus", "coverage"] as const,
  focusAudits: ["dashboard", "focus", "audits"] as const,
  focusMetrics: (days = 7) => ["dashboard", "focus", "metrics", days] as const,
  focusAttentionEvents: (id?: string) => ["dashboard", "focus", "attention-events", id ?? null] as const,
  focusDeliveries: ["dashboard", "focus", "deliveries"] as const,
  focusProtectionRoot: ["dashboard", "focus", "protection"] as const,
  focusProtectionCurrent: ["dashboard", "focus", "protection", "current"] as const,
  focusProtectionHistory: ["dashboard", "focus", "protection", "history"] as const,
  focusMutation: (id: string) => ["focus-mutation", id] as const,
  focusQuietConcerns: (filter: FocusQuietConcernFilter = {}) => ["dashboard", "focus", "quiet-concerns", filter] as const,
  focusEpisode: (id: string, activationId: string) => ["dashboard", "focus", "episode", id, activationId] as const,
  focusLaunchReceipt: (identity: FocusLaunchIdentity) => ["dashboard", "focus", "launch", "identity", identity.objectId, identity.activationId, identity.source] as const,
  focusLaunchReceipts: (id: string, activationId: string) => ["dashboard", "focus", "launch", "episode", id, activationId] as const,
  focusLaunchReceiptById: (id: string) => ["dashboard", "focus", "launch", "receipt", id] as const,
  scheduleSessions: (id: string) => ["schedule", id, "sessions"] as const,
  sessionWorkspace: (sessionId: string, taskId?: string) =>
    ["session-workspace", sessionId, taskId ?? null] as const,
  sessionModel: (sessionId: string) => ["session-model", sessionId] as const,
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
};
