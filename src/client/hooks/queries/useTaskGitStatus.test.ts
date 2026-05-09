import { describe, expect, it, vi, beforeEach } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const fetchTaskGitStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: useQueryMock,
  };
});

vi.mock("../../api", () => ({
  fetchTaskGitStatus: fetchTaskGitStatusMock,
}));

describe("useTaskGitStatusQuery", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    fetchTaskGitStatusMock.mockReset();
  });

  it("uses conservative polling options for expensive git status reads", async () => {
    const { TASK_GIT_STATUS_REFETCH_INTERVAL_MS, useTaskGitStatusQuery } = await import("./useTaskGitStatus.js");

    useTaskGitStatusQuery("task-123");

    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ["task", "task-123", "git-status"],
      enabled: true,
      staleTime: TASK_GIT_STATUS_REFETCH_INTERVAL_MS,
      refetchInterval: TASK_GIT_STATUS_REFETCH_INTERVAL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
    }));
  });

  it("disables the query when a task id or cwd-backed workspace is unavailable", async () => {
    const { useTaskGitStatusQuery } = await import("./useTaskGitStatus.js");

    useTaskGitStatusQuery("task-123", false);
    useTaskGitStatusQuery(undefined);

    expect(useQueryMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ enabled: false }));
    expect(useQueryMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ enabled: false }));
  });
});
