import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";
import type { Task } from "../api";

describe("WorkspaceDetailsSheet", () => {
  it("renders with the legacy flat git-status payload shape", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const task: Task = {
      id: "task-1",
      title: "Workspace task",
      kind: "task",
      status: "active",
      cwd: "/repo",
      notes: "",
      priority: 0,
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessionIds: [],
      workItems: [],
      pullRequests: [],
      tags: [],
    };

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(WorkspaceDetailsSheet, {
          task,
          session: null,
          taskGitStatus: {
            status: "ok",
            cwd: "/repo",
            repoRoot: "/repo",
            repoName: "copilot-bridge",
            branch: "main",
            clean: true,
            staged: 0,
            modified: 0,
            untracked: 0,
          } as any,
          onClose: () => {},
        }),
      ),
    );

    expect(markup).toContain("Git workspace");
    expect(markup).toContain("main");
    expect(markup).toContain("Main checkout");
    expect(markup).toContain("Clean working tree");
    expect(markup).toContain("/repo");
  });
});
