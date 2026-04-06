import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

export const queryKeys = {
  settings: ["settings"] as const,
  tags: ["tags"] as const,
  tasks: ["tasks"] as const,
  taskGroups: ["task-groups"] as const,
  sessions: (opts?: { includeArchived?: boolean }) =>
    ["sessions", opts ?? {}] as const,
  task: (id: string) => ["task", id] as const,
  taskTodos: (id: string) => ["task", id, "todos"] as const,
  taskEnriched: (id: string) => ["task", id, "enriched"] as const,
  taskSchedules: (id: string) => ["task", id, "schedules"] as const,
  chatMessages: (sessionId: string) =>
    ["chat", sessionId, "messages"] as const,
  mcpStatus: (sessionId: string) => ["chat", sessionId, "mcp"] as const,
  dashboard: ["dashboard"] as const,
  relatedDocs: (tagIds: string[]) => ["related-docs", ...tagIds] as const,
};
