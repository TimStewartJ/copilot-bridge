import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "./helpers.js";

const readCachedGitWorktreeStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../git-worktree-status.js", () => ({
  readCachedGitWorktreeStatus: readCachedGitWorktreeStatusMock,
}));

let app: Express;
let taskStore: ReturnType<typeof createTestApp>["ctx"]["taskStore"];

beforeEach(() => {
  readCachedGitWorktreeStatusMock.mockReset();
  const testApp = createTestApp();
  app = testApp.app;
  taskStore = testApp.ctx.taskStore;
});

describe("task git status route", () => {
  it("returns git worktree status for a task cwd", async () => {
    const task = taskStore.createTask("Track git status");
    taskStore.updateTask(task.id, { cwd: "/workspace/copilot-bridge" });
    readCachedGitWorktreeStatusMock.mockResolvedValue({
      status: "ok",
      cwd: "/workspace/copilot-bridge",
      repoRoot: "/workspace/copilot-bridge",
      repoName: "copilot-bridge",
      worktreePath: "/workspace/copilot-bridge",
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: false,
        staged: 1,
        modified: 2,
        untracked: 3,
        conflicts: 0,
      },
      siblingWorktrees: [],
      branch: "main",
      clean: false,
      staged: 1,
      modified: 2,
      untracked: 3,
      conflicts: 0,
    });

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(readCachedGitWorktreeStatusMock).toHaveBeenCalledWith("/workspace/copilot-bridge", { forceRefresh: false });
    expect(res.body).toEqual({
      status: "ok",
      cwd: "/workspace/copilot-bridge",
      repoRoot: "/workspace/copilot-bridge",
      repoName: "copilot-bridge",
      worktreePath: "/workspace/copilot-bridge",
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: false,
        staged: 1,
        modified: 2,
        untracked: 3,
        conflicts: 0,
      },
      siblingWorktrees: [],
      branch: "main",
      clean: false,
      staged: 1,
      modified: 2,
      untracked: 3,
      conflicts: 0,
    });
  });

  it("returns 404 when the task does not exist", async () => {
    const res = await request(app).get("/api/tasks/missing-task/git-status");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Task not found" });
    expect(readCachedGitWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it("forces a cache refresh when requested", async () => {
    const task = taskStore.createTask("Refresh git status");
    taskStore.updateTask(task.id, { cwd: "/workspace/copilot-bridge" });
    readCachedGitWorktreeStatusMock.mockResolvedValue({
      status: "not_repo",
      cwd: "/workspace/copilot-bridge",
    });

    const res = await request(app).get(`/api/tasks/${task.id}/git-status?refresh=1`);

    expect(res.status).toBe(200);
    expect(readCachedGitWorktreeStatusMock).toHaveBeenCalledWith("/workspace/copilot-bridge", { forceRefresh: true });
  });

  it("returns a typed not_configured result when the task has no cwd", async () => {
    const task = taskStore.createTask("No cwd");

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "not_configured",
      error: "Task working directory is not configured.",
    });
    expect(readCachedGitWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it("treats whitespace-only cwd values as not configured", async () => {
    const task = taskStore.createTask("Blank cwd");
    taskStore.updateTask(task.id, { cwd: "   " });

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "not_configured",
      error: "Task working directory is not configured.",
    });
    expect(readCachedGitWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it("passes through typed non-repo responses", async () => {
    const task = taskStore.createTask("Outside repo");
    taskStore.updateTask(task.id, { cwd: "/workspace/not-a-repo" });
    readCachedGitWorktreeStatusMock.mockResolvedValue({
      status: "not_repo",
      cwd: "/workspace/not-a-repo",
    });

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "not_repo",
      cwd: "/workspace/not-a-repo",
    });
  });

  it("returns a typed unavailable result when reading git status throws", async () => {
    const task = taskStore.createTask("Git unavailable");
    taskStore.updateTask(task.id, { cwd: "/workspace/copilot-bridge" });
    readCachedGitWorktreeStatusMock.mockRejectedValue(new Error("spawn git ENOENT"));

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "unavailable",
      cwd: "/workspace/copilot-bridge",
      error: "spawn git ENOENT",
    });
  });
});
