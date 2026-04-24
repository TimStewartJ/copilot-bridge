import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { SessionWorkspaceDetails } from "../../api";
import { fetchSessionWorkspace } from "../../api";
import { queryKeys } from "../../queryClient";
import {
  applyWorkspaceMutationResult,
  getSessionWorkspaceQueryOptions,
  invalidateSessionWorkspaceQueries,
} from "./useSessionWorkspace";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchSessionWorkspace: vi.fn(),
  };
});

describe("getSessionWorkspaceQueryOptions", () => {
  it("fetches task-scoped workspace details with an abort signal", async () => {
    const expected: SessionWorkspaceDetails = {
      sessionId: "session-123",
      taskId: "task-123",
      source: "task",
      pathState: "available",
      warnings: [],
      availableWorktrees: [],
      canResetToTask: true,
      runState: "idle",
      busy: false,
      gitStatus: {
        status: "not_repo",
        cwd: "/workspace/task",
      },
      effectiveCwd: "/workspace/task",
      taskCwd: "/workspace/task",
      overridesTaskWorkspace: false,
    };
    vi.mocked(fetchSessionWorkspace).mockResolvedValue(expected);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const observer = new QueryObserver(queryClient, getSessionWorkspaceQueryOptions("session-123", "task-123"));

    const unsubscribe = observer.subscribe(() => {});
    const result = await observer.refetch();

    expect(result.data).toEqual(expected);
    expect(vi.mocked(fetchSessionWorkspace)).toHaveBeenCalledWith(
      "session-123",
      expect.objectContaining({
        taskId: "task-123",
        signal: expect.any(AbortSignal),
      }),
    );

    unsubscribe();
  });
});

describe("workspace mutation cache updates", () => {
  const workspace: SessionWorkspaceDetails = {
    sessionId: "session-123",
    taskId: "task-123",
    source: "session_workspace",
    pathState: "available",
    warnings: [],
    availableWorktrees: [],
    canResetToTask: true,
    runState: "idle",
    busy: false,
    gitStatus: {
      status: "not_repo",
      cwd: "/workspace/override",
    },
    effectiveCwd: "/workspace/override",
    taskCwd: "/workspace/task",
    sessionOverride: {
      cwd: "/workspace/override",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    overridesTaskWorkspace: true,
  };

  it("invalidates session list and all workspace queries for the session", () => {
    const invalidateQueries = vi.fn();

    invalidateSessionWorkspaceQueries({ invalidateQueries } as any, "session-123");

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace", "session-123"] });
  });

  it("updates only the exact cached workspace query variant for the session", () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const otherWorkspace: SessionWorkspaceDetails = {
      ...workspace,
      taskId: "task-999",
      effectiveCwd: "/workspace/other",
      taskCwd: "/workspace/other-task",
      sessionOverride: {
        cwd: "/workspace/other",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    };

    queryClient.setQueryData(queryKeys.sessionWorkspace("session-123", "task-999"), otherWorkspace);

    applyWorkspaceMutationResult(
      queryClient,
      "session-123",
      workspace,
      "task-123",
    );

    expect(queryClient.getQueryData(queryKeys.sessionWorkspace("session-123", "task-123"))).toEqual(workspace);
    expect(queryClient.getQueryData(queryKeys.sessionWorkspace("session-123", "task-999"))).toEqual(otherWorkspace);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace", "session-123"] });
  });
});
