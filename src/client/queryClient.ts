import { QueryClient } from "@tanstack/react-query";

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
  tags: ["tags"] as const,
  tasks: ["tasks"] as const,
  taskGroups: ["task-groups"] as const,
  sessions: (opts?: { includeArchived?: boolean }) =>
    ["sessions", opts ?? {}] as const,
  task: (id: string) => ["task", id] as const,
  taskTodos: (id: string) => ["task", id, "todos"] as const,
  openTodos: ["todos", "open"] as const,
  taskEnriched: (id: string) => ["task", id, "enriched"] as const,
  taskSchedules: (id: string) => ["task", id, "schedules"] as const,
  allSchedules: ["schedules"] as const,
  scheduleSessions: (id: string) => ["schedule", id, "sessions"] as const,
  chatMessages: (sessionId: string) =>
    ["chat", sessionId, "messages"] as const,
  mcpStatus: (sessionId: string) => ["chat", sessionId, "mcp"] as const,
  dashboard: ["dashboard"] as const,
  copilotUsage: ["copilot-usage"] as const,
  relatedDocs: (tagIds: string[]) => ["related-docs", ...tagIds] as const,
};
